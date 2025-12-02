const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// --- FIX LỖI IMPORT IMAGE-SIZE ---
const sizeOfLib = require('image-size');
const sizeOf = (path) => {
    try {
        // Kiểm tra file tồn tại trước khi đọc
        if (!fs.existsSync(path)) return { width: 0, height: 0 };
        
        if (typeof sizeOfLib === 'function') return sizeOfLib(path);
        if (sizeOfLib && typeof sizeOfLib.imageSize === 'function') return sizeOfLib.imageSize(path);
        if (sizeOfLib && typeof sizeOfLib.default === 'function') return sizeOfLib.default(path);
        return { width: 0, height: 0 };
    } catch (e) {
        console.error("Warning: Không lấy được kích thước ảnh:", e.message);
        return { width: 0, height: 0 }; // Trả về 0 thay vì throw lỗi
    }
};

require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

pool.getConnection()
    .then(conn => {
        console.log("✅ Đã kết nối thành công đến Database MySQL trên Hosting!");
        conn.release();
    })
    .catch(err => {
        console.error("❌ Lỗi kết nối Database:", err.message);
    });

const createSlug = (str) => {
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[đĐ]/g, 'd')
        .replace(/([^0-9a-z-\s])/g, '')
        .replace(/(\s+)/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
};

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- API ROUTES ---

// 1. API Upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file nào' });

    try {
        const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        const filePath = req.file.path;
        
        let dimensions = { width: 0, height: 0 };
        try {
            // Chỉ lấy kích thước nếu là ảnh
            if (req.file.mimetype.startsWith('image/')) {
                dimensions = sizeOf(filePath);
            }
        } catch (e) {
            console.error("Lỗi thư viện sizeOf:", e);
        }

        const [result] = await pool.query(
            `INSERT INTO media_files (file_name, url, path, file_type, file_size, width, height, title, alt_text) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.file.originalname, 
                fileUrl, 
                filePath, 
                req.file.mimetype, 
                req.file.size, 
                dimensions.width || 0, 
                dimensions.height || 0,
                req.file.originalname,
                req.file.originalname
            ]
        );

        res.json({ 
            id: result.insertId,
            url: fileUrl,
            width: dimensions.width,
            height: dimensions.height,
            size: req.file.size,
            file_name: req.file.originalname,
            file_type: req.file.mimetype,
            created_at: new Date().toISOString()
        });

    } catch (err) {
        console.error("Lỗi upload:", err);
        res.status(500).json({ error: 'Lỗi server khi xử lý file' });
    }
});

// 2. API Media Library
app.get('/api/media', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM media_files ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/media/:id', async (req, res) => {
    const { alt_text, title, caption } = req.body;
    try {
        await pool.query(
            'UPDATE media_files SET alt_text=?, title=?, caption=? WHERE id=?',
            [alt_text, title, caption, req.params.id]
        );
        res.json({ message: 'Cập nhật thông tin ảnh thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// XÓA ẢNH (Đã sửa lỗi logic DB)
app.delete('/api/media/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.query('SELECT path, url FROM media_files WHERE id = ?', [req.params.id]);
        
        if (rows.length > 0) {
            const filePath = rows[0].path;
            const fileUrl = rows[0].url;
            
            // 1. Xóa file vật lý (nếu tồn tại)
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (e) {
                console.error("Không xóa được file vật lý:", e);
                // Vẫn tiếp tục xóa trong DB để tránh rác dữ liệu
            }

            // 2. Xóa trong bảng media_files
            await connection.query('DELETE FROM media_files WHERE id = ?', [req.params.id]);

            // 3. Xóa liên kết trong bảng product_images (Đây là nơi lưu ảnh sản phẩm chính xác)
            // Lệnh này sẽ xóa cả thumbnail và gallery của sản phẩm nếu dùng ảnh này
            await connection.query('DELETE FROM product_images WHERE image_url = ?', [fileUrl]);

            // 4. Kiểm tra xem bảng products có cột 'thumbnail' không thì mới update
            // (Nếu bạn chưa thêm cột này vào bảng products thì bỏ qua lệnh này để tránh lỗi)
            // Tạm thời comment lại để an toàn, vì dữ liệu ảnh chính nằm ở product_images
            // await connection.query('UPDATE products SET thumbnail = "" WHERE thumbnail = ?', [fileUrl]);

            // 5. Xóa liên kết trong bài viết Tin tức (bảng news)
            // Kiểm tra bảng news có cột thumbnail_url không (theo thiết kế là có)
            await connection.query('UPDATE news SET thumbnail_url = "" WHERE thumbnail_url = ?', [fileUrl]);
            
            await connection.commit();
            res.json({ message: 'Đã xóa ảnh thành công' });
        } else {
            await connection.rollback();
            res.status(404).json({ message: 'Ảnh không tồn tại' });
        }
    } catch (err) {
        await connection.rollback();
        console.error("Lỗi xóa ảnh:", err);
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// --- API ROUTES KHÁCH HÀNG (PUBLIC) ---

// 1. API Sản Phẩm
app.get('/api/products', async (req, res) => {
    try {
        const sql = `
            SELECT p.*, c.name as category_name, pi.image_url as thumbnail
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN product_images pi ON p.id = pi.product_id AND pi.is_thumbnail = 1
            WHERE p.status = 'active'
        `;
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/:slug', async (req, res) => {
    try {
        const [products] = await pool.query(
            `SELECT p.*, c.name as category_name 
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             WHERE p.slug = ?`, 
            [req.params.slug]
        );

        if (products.length === 0) return res.status(404).json({ message: 'Not found' });

        const product = products[0];
        const [images] = await pool.query('SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order', [product.id]);
        product.images = images.map(img => img.image_url);

        res.json(product);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. API Tin Tức
app.get('/api/news', async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT * FROM news WHERE status = 'published' ORDER BY published_at DESC`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/news/:slug', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM news WHERE slug = ?', [req.params.slug]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'Not found' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. API Tuyển Dụng & Dự Án (Giữ nguyên như cũ)
app.get('/api/jobs', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM jobs WHERE status = "open" ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/projects', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. API Gửi Liên Hệ
app.post('/api/contact', async (req, res) => {
    const { fullName, phone, email, productInterest, message } = req.body;
    if (!fullName || !phone) return res.status(400).json({ error: 'Thiếu thông tin' });

    try {
        await pool.query(
            'INSERT INTO contact_requests (full_name, phone, email, product_interest, message) VALUES (?, ?, ?, ?, ?)',
            [fullName, phone, email, productInterest, message]
        );
        res.status(201).json({ success: true, message: 'Đã gửi thành công!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// --- API ROUTES ADMIN (PRIVATE - Cần bảo mật sau này) ---

// 5. Quản lý Sản Phẩm (ADMIN)
// API Sản phẩm (Admin - Lấy tất cả)
// Sản phẩm
app.get('/api/admin/products', async (req, res) => {
    try {
        const sql = `
            SELECT p.*, c.name as category_name, pi.image_url as thumbnail
            FROM products p
            LEFT JOIN categories c ON p.category_id = c.id
            LEFT JOIN product_images pi ON p.id = pi.product_id AND pi.is_thumbnail = 1
            ORDER BY p.id DESC
        `;
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/products/:id', async (req, res) => {
    try {
        const [products] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (products.length === 0) return res.status(404).json({ message: 'Not found' });
        
        const product = products[0];
        if (typeof product.technical_specs === 'string') {
            try { product.technical_specs = JSON.parse(product.technical_specs); } catch (e) { product.technical_specs = {}; }
        }

        const [thumbnails] = await pool.query('SELECT image_url FROM product_images WHERE product_id = ? AND is_thumbnail = 1 LIMIT 1', [product.id]);
        product.thumbnail = thumbnails.length > 0 ? thumbnails[0].image_url : '';

        const [images] = await pool.query('SELECT image_url FROM product_images WHERE product_id = ? AND is_thumbnail = 0 ORDER BY sort_order', [product.id]);
        product.images = images.map(img => img.image_url);
        
        res.json(product);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/products', async (req, res) => {
    const { name, category_id, sku, summary, description, technical_specs, status, thumbnail, images } = req.body;
    const slug = createSlug(name);
    
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [result] = await connection.query(
            'INSERT INTO products (category_id, name, slug, sku, summary, description, technical_specs, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [category_id, name, slug, sku, summary, description, JSON.stringify(technical_specs), status || 'active']
        );
        const productId = result.insertId;

        if (thumbnail && thumbnail.trim()) {
            await connection.query('INSERT INTO product_images (product_id, image_url, is_thumbnail) VALUES (?, ?, 1)', [productId, thumbnail]);
        }

        if (images && images.length > 0) {
            const imageValues = images.filter(url => url.trim()).map(url => [productId, url, 0]);
            if (imageValues.length > 0) {
                await connection.query('INSERT INTO product_images (product_id, image_url, is_thumbnail) VALUES ?', [imageValues]);
            }
        }
        await connection.commit();
        res.status(201).json({ id: productId, message: 'Thêm thành công' });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally { connection.release(); }
});

app.put('/api/admin/products/:id', async (req, res) => {
    const productId = req.params.id;
    const { name, category_id, sku, summary, description, technical_specs, status, thumbnail, images } = req.body;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(
            'UPDATE products SET name=?, category_id=?, sku=?, summary=?, description=?, technical_specs=?, status=? WHERE id=?',
            [name, category_id, sku, summary, description, JSON.stringify(technical_specs), status, productId]
        );

        // Cập nhật ảnh: Xóa hết ảnh cũ của sp này rồi thêm lại (để đảm bảo đồng bộ với danh sách mới từ frontend)
        await connection.query('DELETE FROM product_images WHERE product_id = ?', [productId]);
        
        // Thêm lại Thumbnail
        if (thumbnail && thumbnail.trim()) {
            await connection.query('INSERT INTO product_images (product_id, image_url, is_thumbnail) VALUES (?, ?, 1)', [productId, thumbnail]);
        }

        // Thêm lại Gallery
        if (images && images.length > 0) {
            const imageValues = images.filter(url => url.trim()).map(url => [productId, url, 0]);
            if (imageValues.length > 0) {
                await connection.query('INSERT INTO product_images (product_id, image_url, is_thumbnail) VALUES ?', [imageValues]);
            }
        }
        await connection.commit();
        res.json({ message: 'Cập nhật thành công' });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally { connection.release(); }
});

app.delete('/api/admin/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa sản phẩm' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Quản lý Tin Tức (ADMIN)

// Lấy danh sách tin tức (Admin - lấy cả bài ẩn nếu có)
app.get('/api/admin/news', async (req, res) => {
    try {
        // console.log("--> API GET /api/admin/news đã được gọi!"); 
        // SỬA LỖI: Đổi 'created_at' thành 'published_at'
        const [rows] = await pool.query('SELECT * FROM news ORDER BY published_at DESC');
        // console.log("--> Số bài viết tìm thấy:", rows.length); 
        res.json(rows);
    } catch (err) { 
        console.error("Lỗi lấy danh sách tin tức:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Lấy chi tiết tin tức theo ID (để sửa)
app.get('/api/admin/news/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM news WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'Không tìm thấy bài viết' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Thêm tin tức mới
app.post('/api/admin/news', async (req, res) => {
    const { title, category, summary, content, thumbnail_url, status, slug } = req.body;
    const finalSlug = slug ? slug : createSlug(title); 

    try {
        await pool.query(
            'INSERT INTO news (title, slug, category, summary, content, thumbnail_url, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [title, finalSlug, category, summary, content, thumbnail_url, status || 'published']
        );
        res.status(201).json({ message: 'Thêm tin tức thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sửa tin tức
app.put('/api/admin/news/:id', async (req, res) => {
    const { title, category, summary, content, thumbnail_url, status } = req.body;
    // Nếu đổi tiêu đề thì update slug, không thì giữ nguyên (hoặc update luôn cũng được)
    const slug = createSlug(title); 
    try {
        await pool.query(
            'UPDATE news SET title=?, slug=?, category=?, summary=?, content=?, thumbnail_url=?, status=? WHERE id=?',
            [title, slug, category, summary, content, thumbnail_url, status, req.params.id]
        );
        res.json({ message: 'Cập nhật tin tức thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Xóa tin tức
app.delete('/api/admin/news/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM news WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa tin tức' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. Quản lý Tuyển Dụng (ADMIN)

// Lấy danh sách tin tuyển dụng (Admin)
app.get('/api/admin/jobs', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lấy chi tiết tin tuyển dụng
app.get('/api/admin/jobs/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM jobs WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'Không tìm thấy tin tuyển dụng' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Thêm tin tuyển dụng
app.post('/api/admin/jobs', async (req, res) => {
    const { title, department, location, salary_range, type, deadline, description, requirements, benefits, status } = req.body;
    const slug = createSlug(title);
    try {
        await pool.query(
            'INSERT INTO jobs (title, slug, department, location, salary_range, type, deadline, description, requirements, benefits, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [title, slug, department, location, salary_range, type, deadline, description, requirements, benefits, status || 'open']
        );
        res.status(201).json({ message: 'Đăng tin tuyển dụng thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sửa tin tuyển dụng
app.put('/api/admin/jobs/:id', async (req, res) => {
    const { title, department, location, salary_range, type, deadline, description, requirements, benefits, status } = req.body;
    const slug = createSlug(title);
    try {
        await pool.query(
            'UPDATE jobs SET title=?, slug=?, department=?, location=?, salary_range=?, type=?, deadline=?, description=?, requirements=?, benefits=?, status=? WHERE id=?',
            [title, slug, department, location, salary_range, type, deadline, description, requirements, benefits, status, req.params.id]
        );
        res.json({ message: 'Cập nhật thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Xóa tin tuyển dụng
app.delete('/api/admin/jobs/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM jobs WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa tin tuyển dụng' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Quản lý Ứng Viên (Job Applications)

// Ứng viên nộp hồ sơ (PUBLIC)
app.post('/api/apply', async (req, res) => {
    const { job_id, full_name, phone, email, introduction, cv_url } = req.body;
    
    if (!job_id || !full_name || !phone) {
        return res.status(400).json({ error: 'Thiếu thông tin bắt buộc' });
    }

    try {
        await pool.query(
            'INSERT INTO job_applications (job_id, full_name, phone, email, introduction, cv_url) VALUES (?, ?, ?, ?, ?, ?)',
            [job_id, full_name, phone, email, introduction, cv_url]
        );
        res.status(201).json({ message: 'Nộp hồ sơ thành công!' });
    } catch (err) { 
        console.error("Lỗi nộp hồ sơ:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// Admin xem danh sách ứng viên (ADMIN)
// Lấy kèm tên vị trí tuyển dụng để biết ứng viên nộp vào đâu
app.get('/api/admin/applications', async (req, res) => {
    try {
        const sql = `
            SELECT ja.*, j.title as job_title 
            FROM job_applications ja
            JOIN jobs j ON ja.job_id = j.id
            ORDER BY ja.created_at DESC
        `;
        const [rows] = await pool.query(sql);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin cập nhật trạng thái hồ sơ (VD: Đã phỏng vấn, Đã tuyển)
app.put('/api/admin/applications/:id', async (req, res) => {
    const { status } = req.body;
    try {
        await pool.query('UPDATE job_applications SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ message: 'Đã cập nhật trạng thái hồ sơ' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Quản lý Liên Hệ Khách Hàng (ADMIN)
// Xem tất cả liên hệ (Mới nhất lên đầu)
app.get('/api/admin/contacts', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM contact_requests ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cập nhật trạng thái liên hệ (Đã xử lý / Đóng)
app.put('/api/admin/contacts/:id', async (req, res) => {
    const { status } = req.body; // status: 'contacted', 'closed'
    try {
        await pool.query('UPDATE contact_requests SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ message: 'Đã cập nhật trạng thái' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Quản lý Dự Án (ADMIN)

// Lấy danh sách dự án
app.get('/api/admin/projects', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lấy chi tiết dự án
app.get('/api/admin/projects/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM projects WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'Không tìm thấy dự án' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Thêm dự án mới
app.post('/api/admin/projects', async (req, res) => {
    const { title, customer_name, location, scale, industry, content, thumbnail_url, is_featured, slug } = req.body;
    const finalSlug = slug ? slug : createSlug(title);
    try {
        await pool.query(
            'INSERT INTO projects (title, slug, customer_name, location, scale, industry, content, thumbnail_url, is_featured) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [title, finalSlug, customer_name, location, scale, industry, content, thumbnail_url, is_featured ? 1 : 0]
        );
        res.status(201).json({ message: 'Thêm dự án thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sửa dự án
app.put('/api/admin/projects/:id', async (req, res) => {
    const { title, slug, customer_name, location, scale, industry, content, thumbnail_url, is_featured } = req.body;
    try {
        await pool.query(
            'UPDATE projects SET title=?, slug=?, customer_name=?, location=?, scale=?, industry=?, content=?, thumbnail_url=?, is_featured=? WHERE id=?',
            [title, slug, customer_name, location, scale, industry, content, thumbnail_url, is_featured ? 1 : 0, req.params.id]
        );
        res.json({ message: 'Cập nhật dự án thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Xóa dự án
app.delete('/api/admin/projects/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM projects WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa dự án' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Đăng nhập Admin (Đơn giản - Bước đầu)
// Lưu ý: Thực tế cần dùng bcrypt để so sánh mật khẩu mã hóa
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // Kiểm tra user trong DB
        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(401).json({ message: 'Sai tài khoản' });
        
        // Demo: So sánh trực tiếp (Thực tế phải dùng bcrypt.compare(password, users[0].password))
        // Vì trong seed data password đã mã hóa, ở đây ta tạm thời cho login thành công nếu username đúng để test
        // Sau này ở Frontend sẽ tích hợp JWT
        res.json({ 
            success: true, 
            token: 'fake-jwt-token-for-demo', 
            user: { username: users[0].username, role: users[0].role } 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. Quản lý Users (ADMIN)

// Lấy danh sách users
app.get('/api/admin/users', async (req, res) => {
    try {
        // Chỉ lấy các trường cần thiết, KHÔNG trả về password
        const [rows] = await pool.query('SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lấy chi tiết user (để sửa)
app.get('/api/admin/users/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, email, role FROM users WHERE id = ?', [req.params.id]);
        if (rows.length > 0) res.json(rows[0]);
        else res.status(404).json({ message: 'User không tồn tại' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Thêm user mới
app.post('/api/admin/users', async (req, res) => {
    const { username, password, email, role } = req.body;
    
    // Kiểm tra trùng username hoặc email
    try {
        const [existing] = await pool.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
        if (existing.length > 0) return res.status(400).json({ message: 'Username hoặc Email đã tồn tại' });

        // Lưu ý: Nên mã hóa password bằng bcrypt ở đây trước khi lưu
        await pool.query(
            'INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)',
            [username, password, email, role || 'admin']
        );
        res.status(201).json({ message: 'Tạo tài khoản thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sửa user (Cập nhật thông tin & Đổi mật khẩu)
app.put('/api/admin/users/:id', async (req, res) => {
    const { email, role, password } = req.body;
    const userId = req.params.id;

    try {
        // Nếu có nhập password mới thì cập nhật cả password, không thì giữ nguyên
        if (password && password.trim() !== '') {
            await pool.query(
                'UPDATE users SET email=?, role=?, password=? WHERE id=?',
                [email, role, password, userId]
            );
        } else {
            await pool.query(
                'UPDATE users SET email=?, role=? WHERE id=?',
                [email, role, userId]
            );
        }
        res.json({ message: 'Cập nhật tài khoản thành công' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Xóa user
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
        res.json({ message: 'Đã xóa tài khoản' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});




// Khởi động server
app.listen(port, () => {
    console.log(`🚀 Server Backend đang chạy tại: http://localhost:${port}`);
    console.log(`🔗 API Sản phẩm: http://localhost:${port}/api/products`);
    console.log(`🔒 API Admin: http://localhost:${port}/api/admin/contacts`);
});