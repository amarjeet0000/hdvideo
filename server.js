// server.js - Full E-Commerce Backend with Dynamic Category and Subcategory Image Management
// Cloudinary, Razorpay, and Twilio Integrations
// This code is an expansion of the provided file to include all documented endpoints.

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const twilio = require('twilio');
const fs = require('fs').promises;
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { log } = require('console');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// --------- Setup & Clients ----------
// Twilio for WhatsApp notifications
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
// Razorpay for online payments
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

// Configure Cloudinary for image and video storage
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(async () => {
        console.log('✅ MongoDB connected');

        // Initial check to create default categories if the database is empty
        try {
            const categoryCount = await Category.countDocuments();
            if (categoryCount === 0) {
                console.log('No categories found. Creating default categories...');
                const defaultCategories = [
                    { name: 'Fruits', slug: 'fruits' },
                    { name: 'Vegetables', slug: 'vegetables' },
                    { name: 'Clothing', slug: 'clothing' },
                ];
                const createdCategories = await Category.insertMany(defaultCategories);
                console.log('Default categories created:', createdCategories.map(c => c.name));

                const fruitsId = createdCategories.find(c => c.name === 'Fruits')._id;
                const vegetablesId = createdCategories.find(c => c.name === 'Vegetables')._id;

                const defaultSubcategories = [
                    { name: 'Mango', category: fruitsId, isTopLevel: true },
                    { name: 'Apple', category: fruitsId, isTopLevel: true },
                    { name: 'Onion', category: vegetablesId, isTopLevel: true },
                    { name: 'Potato', category: vegetablesId, isTopLevel: true },
                ];
                const createdSubcategories = await Subcategory.insertMany(defaultSubcategories);
                console.log('Default subcategories created.');

                const mangoId = createdSubcategories.find(s => s.name === 'Mango')._id;
                const neelamMango = {
                    name: 'Neelam Mango',
                    category: fruitsId,
                    parent: mangoId,
                    isTopLevel: false
                };
                await Subcategory.create(neelamMango);
                console.log('3-level subcategory created for Neelam Mango.');
            }
        } catch (err) {
            console.error('Error creating default categories:', err);
        }
    })
    .catch(err => console.error('❌ MongoDB connection error:', err));

// --------- Multer with Cloudinary Storage ----------
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: (req, file) => {
            if (req.originalUrl.includes('products')) return 'ecommerce/products';
            if (req.originalUrl.includes('categories')) return 'ecommerce/categories';
            if (req.originalUrl.includes('subcategories')) return 'ecommerce/subcategories';
            if (req.originalUrl.includes('banners')) return 'ecommerce/banners';
            if (req.originalUrl.includes('splash')) return 'ecommerce/splash';
            return 'ecommerce/general';
        },
        resource_type: (req, file) => {
            if (file.mimetype.startsWith('video')) return 'video';
            return 'image';
        },
        allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'],
    },
});
const upload = multer({ storage });
const uploadSingleMedia = upload.single('media');

// --------- Notifications ----------
async function sendWhatsApp(to, message) {
    try {
        if (!to) return;
        const normalized = to.replace(/\D/g, '');
        const toNumber = (normalized.length === 12 && normalized.startsWith('91')) ? `whatsapp:+${normalized}` : `whatsapp:+91${normalized}`;
        await twilioClient.messages.create({
            body: message,
            from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
            to: toNumber
        });
        console.log(`WhatsApp sent to ${toNumber}`);
    } catch (err) {
        console.error('WhatsApp failed:', err && err.message ? err.message : err);
    }
}

async function notifyAdmin(message) {
    if (process.env.WHATSAPP_ADMIN_NUMBER) await sendWhatsApp(process.env.WHATSAPP_ADMIN_NUMBER, message);
    else console.log('Admin WhatsApp not configured. Message:', message);
}

// --------- Models ----------
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    phone: { type: String, unique: true, sparse: true },
    role: { type: String, enum: ['user', 'seller', 'admin'], default: 'user' },
    pincodes: { type: [String], default: [] },
    approved: { type: Boolean, default: true },
    resetPasswordToken: String,
    resetPasswordExpire: Date
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
    image: {
        url: String,
        publicId: String
    }
}, { timestamps: true });
const Category = mongoose.model('Category', categorySchema);

const subcategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    isTopLevel: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    image: {
        url: String,
        publicId: String
    }
}, { timestamps: true });
const Subcategory = mongoose.model('Subcategory', subcategorySchema);

// New and updated Product schema
const productSchema = new mongoose.Schema({
    // Basic Info
    name: String,
    brand: { type: String, default: 'Unbranded' },
    sku: String, // New field for SKU/Product Code
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    childCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null }, // New field for child category

    // Pricing & Stock
    originalPrice: Number, // MRP
    price: Number, // Selling Price
    stock: { type: Number, default: 10 },
    unit: {
        type: String,
        enum: ['kg', '100g', '250g', '500g', 'L', 'ml', 'pcs', 'pack', 'piece', 'bunch', 'packet', 'dozen', 'bag', '50g'],
        required: true,
        default: 'pcs'
    },
    minOrderQty: { type: Number, default: 1 }, // New field for minimum order quantity

    // Description
    shortDescription: String, // New field for short description
    fullDescription: String, // New field for full description
    
    // Media
    images: [{
        url: String,
        publicId: String
    }],
    videoLink: String, // New field for video link
    
    // Specifications (category-wise different fields)
    specifications: { type: Map, of: String, default: {} },
    
    // Variants (Optional)
    variants: { type: Map, of: [String], default: {} }, // New field for variants like color, size, storage

    // Shipping Details
    shippingDetails: { // New nested schema for shipping details
        weight: Number,
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
        },
        shippingType: { type: String, enum: ['Free', 'Paid', 'COD Available'], default: 'Free' },
    },

    // Other Information
    otherInformation: { // New nested schema for other info
        warranty: String,
        returnPolicy: String,
        tags: [String],
    },

    // General
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isTrending: { type: Boolean, default: false }
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

const couponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, uppercase: true },
    discountType: { type: String, enum: ['percentage', 'fixed'], required: true },
    discountValue: { type: Number, required: true },
    maxDiscountAmount: Number,
    minPurchaseAmount: { type: Number, default: 0 },
    expiryDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true }
}, { timestamps: true });
const Coupon = mongoose.model('Coupon', couponSchema);

const bannerSchema = new mongoose.Schema({
    title: String,
    image: {
        url: String,
        publicId: String
    },
    link: String,
    type: { type: String, enum: ['image', 'video'], default: 'image' },
    position: { type: String, enum: ['top', 'middle', 'bottom'], default: 'top' },
    isActive: { type: Boolean, default: true },
    video: {
        url: String,
        publicId: String
    }
}, { timestamps: true });
const Banner = mongoose.model('Banner', bannerSchema);

const splashSchema = new mongoose.Schema({
    title: String,
    image: {
        url: String,
        publicId: String
    },
    video: {
        url: String,
        publicId: String
    },
    link: String,
    type: { type: String, enum: ['scheduled', 'default'], default: 'default' },
    startDate: Date,
    endDate: Date,
    isActive: { type: Boolean, default: true },
}, { timestamps: true });
const Splash = mongoose.model('Splash', splashSchema);

const orderSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    orderItems: [{
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        qty: Number,
        originalPrice: Number,
        price: Number,
        category: String
    }],
    shippingAddress: { type: String, required: true },
    deliveryStatus: { type: String, enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'], default: 'Pending' },
    paymentMethod: { type: String, enum: ['cod', 'razorpay'], required: true },
    paymentId: String,
    paymentStatus: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
    pincode: String,
    totalAmount: Number,
    couponApplied: String,
    discountAmount: { type: Number, default: 0 },
    refunds: [{
        amount: Number,
        reason: String,
        status: { type: String, enum: ['requested', 'approved', 'processing', 'completed', 'rejected'], default: 'requested' },
        razorpayRefundId: String,
        processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        createdAt: Date,
        updatedAt: Date
    }],
    totalRefunded: { type: Number, default: 0 },
    history: [{ status: String, timestamp: { type: Date, default: Date.now } }]
}, { timestamps: true });
const Order = mongoose.model('Order', orderSchema);

const cartSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: [{
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        qty: { type: Number, required: true, default: 1 },
    }]
}, { timestamps: true });
const Cart = mongoose.model('Cart', cartSchema);

const wishlistSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }]
}, { timestamps: true });
const Wishlist = mongoose.model('Wishlist', wishlistSchema);

const addressSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    street: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    phone: String,
    isDefault: { type: Boolean, default: false }
}, { timestamps: true });
const Address = mongoose.model('Address', addressSchema);

const reviewSchema = new mongoose.Schema({
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true },
}, { timestamps: true });
const Review = mongoose.model('Review', reviewSchema);

const likeSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
}, { timestamps: true });
const Like = mongoose.model('Like', likeSchema);

const paymentHistorySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
    createdAt: { type: Date, default: Date.now },
});
const PaymentHistory = mongoose.model('PaymentHistory', paymentHistorySchema);

// New Booking Schema
const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    bookingDate: { type: Date, required: true },
    address: { type: String, required: true },
    status: {
        type: String,
        enum: ['Pending', 'Accepted', 'Rejected', 'Completed', 'Cancelled'],
        default: 'Pending'
    },
    notes: String,
}, { timestamps: true });
const Booking = mongoose.model('Booking', bookingSchema);


// --------- Middleware ----------
const protect = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'No token' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select('-password');
        if (!req.user) return res.status(401).json({ message: 'Invalid token' });
        next();
    } catch (err) {
        res.status(401).json({ message: 'Token error' });
    }
};

const authorizeRole = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Access denied' });
    next();
};

function checkSellerApproved(req, res, next) {
    if (req.user.role === 'seller' && !req.user.approved) return res.status(403).json({ message: 'Seller account not approved yet' });
    next();
}

// --------- Category Routes (Handles Level 1 CRUD) ----------
app.get('/api/categories', async (req, res) => {
    try {
        const { active } = req.query;
        const filter = {};
        if (typeof active !== 'undefined') filter.isActive = active === 'true';
        const categories = await Category.find(filter).sort({ name: 1 }).select('name slug isActive image');
        res.json(categories);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching categories', error: err.message });
    }
});

app.get('/api/categories/:id', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) return res.status(404).json({ message: 'Category not found' });
        res.json(category);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching category', error: err.message });
    }
});

app.get('/api/admin/categories', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { active } = req.query;
        const filter = {};
        if (typeof active !== 'undefined') filter.isActive = active === 'true';
        const categories = await Category.find(filter).sort({ name: 1 }).select('name slug isActive image');
        res.json(categories);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching categories', error: err.message });
    }
});

app.post('/api/admin/categories', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ message: 'Category name is required' });
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const category = await Category.create({
            name, slug,
            image: {
                url: req.file ? req.file.path : undefined,
                publicId: req.file ? req.file.filename : undefined,
            }
        });
        res.status(201).json(category);
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: 'Category with this name already exists' });
        res.status(500).json({ message: 'Error creating category', error: err.message });
    }
});

app.put('/api/admin/categories/:id', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name, isActive } = req.body;
        const category = await Category.findById(req.params.id);
        if (!category) return res.status(404).json({ message: 'Category not found' });
        if (req.file) {
            if (category.image && category.image.publicId) await cloudinary.uploader.destroy(category.image.publicId);
            category.image = { url: req.file.path, publicId: req.file.filename };
        }
        if (name) {
            category.name = name;
            category.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        }
        if (typeof isActive !== 'undefined') category.isActive = isActive;
        await category.save();
        res.json(category);
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ message: 'Category with this name already exists' });
        res.status(500).json({ message: 'Error updating category', error: err.message });
    }
});

app.delete('/api/admin/categories/:id', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) return res.status(404).json({ message: 'Category not found' });
        const productsCount = await Product.countDocuments({ category: category._id });
        if (productsCount > 0) return res.status(400).json({ message: 'Cannot delete category with products', productsCount });
        const subcategoriesCount = await Subcategory.countDocuments({ category: category._id });
        if (subcategoriesCount > 0) return res.status(400).json({ message: 'Cannot delete category with subcategories', subcategoriesCount });
        if (category.image && category.image.publicId) await cloudinary.uploader.destroy(category.image.publicId);
        await category.deleteOne();
        res.json({ message: 'Category deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting category', error: err.message });
    }
});

// --------- Subcategory Routes (Handles Level 2 & 3 CRUD) ----------
app.get('/api/subcategories', async (req, res) => {
    try {
        const { active, categoryId, parentId } = req.query;
        const filter = {};
        if (typeof active !== 'undefined') filter.isActive = active === 'true';
        if (categoryId) filter.category = categoryId;
        if (parentId) {
            filter.parent = parentId;
        } else {
            filter.isTopLevel = true;
        }
        const subcategories = await Subcategory.find(filter).populate('category', 'name slug image').sort({ name: 1 });
        res.json(subcategories);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching subcategories', error: err.message });
    }
});

app.get('/api/subcategories/:id', async (req, res) => {
    try {
        const subcategory = await Subcategory.findById(req.params.id).populate('category', 'name slug image').populate('parent');
        if (!subcategory) return res.status(404).json({ message: 'Subcategory not found' });
        res.json(subcategory);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching subcategory', error: err.message });
    }
});

app.get('/api/admin/subcategories', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { active, categoryId, parentId, isTopLevel } = req.query;
        const filter = {};
        if (typeof active !== 'undefined') filter.isActive = active === 'true';
        if (categoryId) filter.category = categoryId;
        if (parentId) {
            filter.parent = parentId;
        }
        if (isTopLevel) {
            filter.isTopLevel = isTopLevel === 'true';
        }
        const subcategories = await Subcategory.find(filter).populate('category', 'name slug image').sort({ name: 1 });
        res.json(subcategories);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching subcategories', error: err.message });
    }
});

app.post('/api/admin/subcategories', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name, categoryId, parentId } = req.body;
        if (!name || !categoryId) return res.status(400).json({ message: 'Name and category are required' });

        const isTopLevel = parentId ? false : true;

        const subcategory = await Subcategory.create({
            name,
            category: categoryId,
            parent: parentId,
            isTopLevel,
            image: {
                url: req.file ? req.file.path : undefined,
                publicId: req.file ? req.file.filename : undefined,
            }
        });
        res.status(201).json(subcategory);
    } catch (err) {
        res.status(500).json({ message: 'Error creating subcategory', error: err.message });
    }
});

app.put('/api/admin/subcategories/:id', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name, categoryId, parentId, isActive } = req.body;
        const subcategory = await Subcategory.findById(req.params.id);
        if (!subcategory) return res.status(404).json({ message: 'Subcategory not found' });

        const isTopLevel = parentId ? false : true;

        if (req.file) {
            if (subcategory.image && subcategory.image.publicId) await cloudinary.uploader.destroy(subcategory.image.publicId);
            subcategory.image = { url: req.file.path, publicId: req.file.filename };
        }
        if (name) subcategory.name = name;
        if (categoryId) subcategory.category = categoryId;
        if (typeof parentId !== 'undefined') subcategory.parent = parentId;
        if (typeof isActive !== 'undefined') subcategory.isActive = isActive;
        subcategory.isTopLevel = isTopLevel;

        await subcategory.save();
        res.json(subcategory);
    } catch (err) {
        res.status(500).json({ message: 'Error updating subcategory', error: err.message });
    }
});

app.delete('/api/admin/subcategories/:id', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const subcategory = await Subcategory.findById(req.params.id);
        if (!subcategory) return res.status(404).json({ message: 'Subcategory not found' });

        const nestedSubcategoriesCount = await Subcategory.countDocuments({ parent: subcategory._id });
        if (nestedSubcategoriesCount > 0) return res.status(400).json({ message: 'Cannot delete subcategory with nested subcategories' });

        const productsCount = await Product.countDocuments({ subcategory: subcategory._id });
        if (productsCount > 0) return res.status(400).json({ message: 'Cannot delete subcategory with products', productsCount });

        if (subcategory.image && subcategory.image.publicId) await cloudinary.uploader.destroy(subcategory.image.publicId);
        await subcategory.deleteOne();
        res.json({ message: 'Subcategory deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting subcategory', error: err.message });
    }
});

// --------- Auth Routes ----------
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, phone, role = 'user', pincodes } = req.body;
        if (!name || !password || !phone) return res.status(400).json({ message: 'Name, password, and phone number are required' });

        const existingUser = await User.findOne({ $or: [{ email }, { phone }] });
        if (existingUser) {
            return res.status(409).json({ message: 'User with this email or phone number already exists' });
        }

        const hashed = await bcrypt.hash(password, 10);
        const approved = role === 'seller' ? false : true;
        const user = await User.create({ name, email, password: hashed, phone, role, pincodes: Array.isArray(pincodes) ? pincodes : [], approved });

        if (role === 'seller') {
            await notifyAdmin(`🆕 New Seller Registered (pending approval)\n\nName: ${user.name}\nEmail: ${user.email}\nPhone: ${user.phone}`);
        }

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, pincodes: user.pincodes, approved: user.approved } });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { phone, password, email } = req.body;
        if (!password || (!email && !phone)) {
            return res.status(400).json({ message: 'Password and either email or phone number are required' });
        }

        let user;
        if (email) {
            user = await User.findOne({ email });
            if (user && user.role === 'user') {
                return res.status(403).json({ message: 'Invalid role for email login' });
            }
        } else if (phone) {
            user = await User.findOne({ phone });
            if (user && (user.role === 'seller' || user.role === 'admin')) {
                return res.status(403).json({ message: 'Invalid role for phone number login' });
            }
        }

        if (!user) return res.status(401).json({ message: 'Invalid credentials' });

        if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: 'Invalid credentials' });

        if (user.role === 'seller' && !user.approved) return res.status(403).json({ message: 'Seller account awaiting admin approval' });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, pincodes: user.pincodes, approved: user.approved } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Login error' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: 'Phone number is required' });

        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(404).json({ message: 'User not found with this phone number' });
        }

        const token = crypto.randomBytes(20).toString('hex');
        user.resetPasswordToken = crypto.createHash('sha256').update(token).digest('hex');
        user.resetPasswordExpire = Date.now() + 3600000;
        await user.save();

        const resetUrl = `http://0.0.0.0:5001/api/auth/reset-password/${token}`;
        const message = `Namaste! You have requested a password reset. Please use the following link to reset your password: ${resetUrl}. This link is valid for 1 hour.`;

        await sendWhatsApp(user.phone, message);

        res.status(200).json({ message: 'Password reset link sent to your WhatsApp number' });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ message: 'Error processing forgot password request' });
    }
});

app.post('/api/auth/reset-password/:token', async (req, res) => {
    try {
        const { password } = req.body;
        const resetPasswordToken = crypto.createHash('sha256').update(req.params.token).digest('hex');

        const user = await User.findOne({
            resetPasswordToken,
            resetPasswordExpire: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired token' });
        }

        user.password = await bcrypt.hash(password, 10);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        res.status(200).json({ message: 'Password reset successfully' });
    } catch (err) {
        console.status(500).json({ message: 'Error resetting password' });
    }
});

app.get('/api/auth/profile', protect, async (req, res) => {
    try {
        res.json(req.user);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching profile' });
    }
});

app.put('/api/auth/profile', protect, async (req, res) => {
    try {
        const { name, phone, pincodes } = req.body;
        const user = await User.findById(req.user._id);
        if (name) user.name = name;
        if (phone) user.phone = phone;
        if (pincodes && pincodes.length) user.pincodes = pincodes;
        await user.save();
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Error updating profile' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

// --------- Product Routes ----------
app.get('/api/products', async (req, res) => {
    try {
        const { search, minPrice, maxPrice, categoryId, brand, subcategoryId, sellerId, excludeProductId } = req.query;
        const filter = {};
        if (search) filter.$or = [{ name: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
        if (minPrice || maxPrice) {
            filter.price = {};
            if (minPrice) filter.price.$gte = Number(minPrice);
            if (maxPrice) filter.price.$lte = Number(maxPrice);
        }
        if (categoryId) filter.category = categoryId;
        if (brand) filter.brand = { $regex: brand, $options: 'i' };
        if (subcategoryId) filter.subcategory = subcategoryId;
        if (sellerId) filter.seller = sellerId;
        if (excludeProductId) filter._id = { $ne: excludeProductId };

        const products = await Product.find(filter).populate('seller', 'name email phone pincodes').populate('subcategory', 'name image').populate('category', 'name image');
        res.json(products);
    } catch (err) {
        console.error("Get Products Error:", err);
        res.status(500).json({ message: 'Error fetching products' });
    }
});

app.get('/api/products/trending', async (req, res) => {
    try {
        const trendingProducts = await Product.find({ isTrending: true }).limit(10).populate('seller', 'name email').populate('category', 'name').populate('subcategory', 'name');
        res.json(trendingProducts);
    } catch (err) {
        console.error("Get Trending Products Error:", err);
        res.status(500).json({ message: 'Error fetching trending products' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id)
            .populate('seller', 'name email phone pincodes')
            .populate('subcategory', 'name image')
            .populate('category', 'name image');
        if (!product) return res.status(404).json({ message: 'Product not found' });
        res.json(product);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching product', error: err.message });
    }
});

// --------- Cart Routes ----------
app.get('/api/cart', protect, async (req, res) => {
    try {
        const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
        if (!cart) return res.status(404).json({ message: 'Cart not found' });
        res.json(cart);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching cart' });
    }
});

app.post('/api/cart', protect, async (req, res) => {
    try {
        const { productId, qty = 1 } = req.body;
        const product = await Product.findById(productId);
        if (!product) return res.status(404).json({ message: 'Product not found' });
        if (product.stock < qty) return res.status(400).json({ message: 'Insufficient stock' });

        let cart = await Cart.findOne({ user: req.user._id });
        if (!cart) {
            cart = await Cart.create({ user: req.user._id, items: [] });
        }

        const itemIndex = cart.items.findIndex(item => item.product.toString() === productId);
        if (itemIndex > -1) {
            cart.items[itemIndex].qty += qty;
        } else {
            cart.items.push({ product: productId, qty });
        }

        await cart.save();
        res.status(200).json(cart);
    } catch (err) {
        res.status(500).json({ message: 'Error adding item to cart' });
    }
});

app.put('/api/cart/:itemId', protect, async (req, res) => {
    try {
        const { qty } = req.body;
        const cart = await Cart.findOne({ user: req.user._id });
        if (!cart) return res.status(404).json({ message: 'Cart not found' });

        const item = cart.items.find(item => item._id.toString() === req.params.itemId);
        if (!item) return res.status(404).json({ message: 'Item not found in cart' });

        const product = await Product.findById(item.product);
        if (!product) return res.status(404).json({ message: 'Product not found' });
        if (product.stock < qty) return res.status(400).json({ message: 'Insufficient stock' });

        item.qty = qty;
        await cart.save();
        res.json(cart);
    } catch (err) {
        res.status(500).json({ message: 'Error updating cart item' });
    }
});

app.delete('/api/cart/:itemId', protect, async (req, res) => {
    try {
        const cart = await Cart.findOneAndUpdate(
            { user: req.user._id },
            { $pull: { items: { _id: req.params.itemId } } },
            { new: true }
        );
        if (!cart) return res.status(404).json({ message: 'Cart not found' });
        res.json(cart);
    } catch (err) {
        res.status(500).json({ message: 'Error removing item from cart' });
    }
});

// --------- Wishlist Routes ----------
app.get('/api/wishlist', protect, async (req, res) => {
    try {
        const wishlist = await Wishlist.findOne({ user: req.user._id }).populate('products');
        if (!wishlist) return res.status(404).json({ message: 'Wishlist not found' });
        res.json(wishlist);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching wishlist' });
    }
});

app.post('/api/wishlist', protect, async (req, res) => {
    try {
        const { productId } = req.body;
        let wishlist = await Wishlist.findOne({ user: req.user._id });
        if (!wishlist) {
            wishlist = await Wishlist.create({ user: req.user._id, products: [] });
        }
        if (!wishlist.products.includes(productId)) {
            wishlist.products.push(productId);
            await wishlist.save();
        }
        res.status(200).json(wishlist);
    } catch (err) {
        res.status(500).json({ message: 'Error adding product to wishlist' });
    }
});

app.delete('/api/wishlist/:id', protect, async (req, res) => {
    try {
        const wishlist = await Wishlist.findOneAndUpdate(
            { user: req.user._id },
            { $pull: { products: req.params.id } },
            { new: true }
        );
        if (!wishlist) return res.status(404).json({ message: 'Wishlist not found' });
        res.json(wishlist);
    } catch (err) {
        res.status(500).json({ message: 'Error removing product from wishlist' });
    }
});

// --------- Likes Routes ----------
app.post('/api/products/:id/like', protect, async (req, res) => {
    try {
        const productId = req.params.id;
        const userId = req.user._id;

        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }

        const existingLike = await Like.findOne({ product: productId, user: userId });
        if (existingLike) {
            return res.status(409).json({ message: 'Product already liked by this user' });
        }

        const newLike = new Like({ product: productId, user: userId });
        await newLike.save();

        res.status(201).json({ message: 'Product liked successfully' });
    } catch (err) {
        console.error('Like product error:', err);
        res.status(500).json({ message: 'Error liking product' });
    }
});

app.delete('/api/products/:id/like', protect, async (req, res) => {
    try {
        const productId = req.params.id;
        const userId = req.user._id;

        const result = await Like.deleteOne({ product: productId, user: userId });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: 'Like not found' });
        }

        res.json({ message: 'Product unliked successfully' });
    } catch (err) {
        console.error('Unlike product error:', err);
        res.status(500).json({ message: 'Error unliking product' });
    }
});


// --------- Orders Routes ----------
app.post('/api/orders', protect, async (req, res) => {
    try {
        const { shippingAddressId, paymentMethod, couponCode, pincode } = req.body;
        const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');

        if (!cart || cart.items.length === 0) {
            return res.status(400).json({ message: 'Cart is empty' });
        }
        const shippingAddress = await Address.findById(shippingAddressId);
        if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });

        const ordersBySeller = new Map();
        for (const item of cart.items) {
            const product = item.product;
            if (product.stock < item.qty) {
                return res.status(400).json({ message: `Insufficient stock for product: ${product.name}` });
            }

            const sellerId = product.seller.toString();
            if (!ordersBySeller.has(sellerId)) {
                ordersBySeller.set(sellerId, {
                    seller: product.seller,
                    orderItems: [],
                    totalAmount: 0,
                });
            }

            const sellerOrder = ordersBySeller.get(sellerId);
            sellerOrder.orderItems.push({
                product: product._id,
                name: product.name,
                qty: item.qty,
                originalPrice: product.originalPrice,
                price: product.price,
                category: product.category,
            });
            sellerOrder.totalAmount += product.price * item.qty;
        }

        let discountAmount = 0;
        let finalAmountForPayment = 0;
        let couponDetails = null;

        if (couponCode) {
            const totalCartAmount = Array.from(ordersBySeller.values()).reduce((sum, order) => sum + order.totalAmount, 0);
            const coupon = await Coupon.findOne({
                code: couponCode,
                isActive: true,
                expiryDate: { $gt: new Date() },
                minPurchaseAmount: { $lte: totalCartAmount }
            });

            if (coupon) {
                if (coupon.discountType === 'percentage') {
                    discountAmount = totalCartAmount * (coupon.discountValue / 100);
                    if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
                        discountAmount = coupon.maxDiscountAmount;
                    }
                } else if (coupon.discountType === 'fixed') {
                    discountAmount = coupon.discountValue;
                }
                couponDetails = coupon;
                finalAmountForPayment = Math.max(0, totalCartAmount - discountAmount);
            }
        } else {
            finalAmountForPayment = Array.from(ordersBySeller.values()).reduce((sum, order) => sum + order.totalAmount, 0);
        }

        if (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) {
            return res.status(400).json({ message: 'Payment amount must be greater than zero for Razorpay' });
        }

        let razorpayOrder = null;
        if (paymentMethod === 'razorpay') {
            razorpayOrder = await razorpay.orders.create({
                amount: Math.round(finalAmountForPayment * 100),
                currency: 'INR',
                receipt: `order_rcpt_${req.user._id}_${Date.now()}`,
            });
        }

        const createdOrders = [];
        for (const [sellerId, sellerData] of ordersBySeller.entries()) {
            const order = new Order({
                user: req.user._id,
                seller: sellerData.seller,
                orderItems: sellerData.orderItems,
                shippingAddress: `${shippingAddress.street}, ${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}`,
                pincode: shippingAddress.pincode,
                paymentMethod,
                totalAmount: sellerData.totalAmount,
                couponApplied: couponCode,
                discountAmount: (discountAmount * sellerData.totalAmount) / finalAmountForPayment || 0,
                paymentId: razorpayOrder ? razorpayOrder.id : undefined,
                history: [{ status: 'Pending' }]
            });
            await order.save();
            createdOrders.push(order);

            for(const item of sellerData.orderItems) {
                await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
            }
        }

        await Cart.deleteOne({ user: req.user._id });

        res.status(201).json({
            message: 'Orders created successfully',
            orders: createdOrders.map(o => o._id),
            razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount } : undefined
        });

    } catch (err) {
        console.error('Create order error:', err);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: 'Error creating order', error: err.message });
    }
});

app.get('/api/orders', protect, async (req, res) => {
    try {
        // Fetch orders and convert them to plain JavaScript objects for modification
        const orders = await Order.find({ user: req.user._id }).populate({
            path: 'orderItems.product',
            select: 'name images price originalPrice', // Ensure 'images' is selected
        }).populate('seller', 'name email').sort({ createdAt: -1 }).lean();

        // Map over orders to add a representative 'displayImage' for the frontend
        const ordersWithDisplayImage = orders.map(order => {
            let image = null;
            // Safely get the first image from the first product in the order
            if (order.orderItems?.[0]?.product?.images?.[0]?.url) {
                image = order.orderItems[0].product.images[0].url;
            }
            return { ...order, displayImage: image };
        });

        res.json(ordersWithDisplayImage);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

app.get('/api/orders/:id', protect, async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
            .populate({
                path: 'orderItems.product',
                select: 'name images price originalPrice',
            })
            .populate('seller', 'name email');
        if (!order) return res.status(404).json({ message: 'Order not found or you do not have permission' });
        res.json(order);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching order details' });
    }
});

app.put('/api/orders/:id/cancel', protect, async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
        if (!order) return res.status(404).json({ message: 'Order not found or you do not have permission' });
        if (order.deliveryStatus === 'Cancelled' || order.deliveryStatus === 'Delivered' || order.deliveryStatus === 'Shipped') {
            return res.status(400).json({ message: `Cannot cancel an order that is already ${order.deliveryStatus}` });
        }

        order.deliveryStatus = 'Cancelled';
        order.history.push({ status: 'Cancelled' });
        await order.save();

        for(const item of order.orderItems) {
            await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
        }

        res.json({ message: 'Order cancelled successfully', order });
    } catch (err) {
        res.status(500).json({ message: 'Error cancelling order' });
    }
});


// --------- Bookings Routes ----------
app.post('/api/bookings', protect, async (req, res) => {
    try {
        const { serviceId, bookingDate, address, notes } = req.body;
        const service = await Product.findById(serviceId).populate('seller');
        if (!service) return res.status(404).json({ message: 'Service not found.' });

        const newBooking = await Booking.create({
            user: req.user._id,
            provider: service.seller._id,
            service: serviceId,
            bookingDate,
            address,
            notes,
        });

        const providerPhone = service.seller.phone;
        const message = `🎉 New Booking Request!\n\nService: ${service.name}\nUser: ${req.user.name}\nDate: ${new Date(bookingDate).toLocaleDateString()}.\nPlease log in to your panel to accept or reject.`;
        await sendWhatsApp(providerPhone, message);

        res.status(201).json(newBooking);
    } catch (err) {
        console.error('Create booking error:', err);
        res.status(500).json({ message: 'Error creating booking.' });
    }
});

app.put('/api/bookings/:id/status', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const { status } = req.body;
        const booking = await Booking.findById(req.params.id).populate('user service');
        if (!booking) return res.status(404).json({ message: 'Booking not found.' });

        if (booking.provider.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        booking.status = status;
        await booking.save();
        
        const userPhone = booking.user.phone;
        const message = `Booking Update!\n\nYour booking for "${booking.service.name}" has been ${status}.`;
        await sendWhatsApp(userPhone, message);

        res.json(booking);
    } catch (err) {
        res.status(500).json({ message: 'Error updating booking status.' });
    }
});

app.get('/api/my-bookings', protect, async (req, res) => {
    try {
        const bookings = await Booking.find({ user: req.user._id }).populate('service', 'name images').populate('provider', 'name').sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching your bookings.' });
    }
});

app.get('/api/provider-bookings', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const bookings = await Booking.find({ provider: req.user._id }).populate('service', 'name').populate('user', 'name phone').sort({ createdAt: -1 });
        res.json(bookings);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching provider bookings.' });
    }
});

// --------- Payments Routes ----------
app.post('/api/payment/create-order', protect, async (req, res) => {
    res.status(501).json({ message: 'This endpoint is not fully implemented. Payment is initiated via the /api/orders route.' });
});

app.post('/api/payment/verify', async (req, res) => {
    try {
        const { order_id, payment_id, signature } = req.body;
        const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
        shasum.update(`${order_id}|${payment_id}`);
        const digest = shasum.digest('hex');

        if (digest === signature) {
            const order = await Order.findOne({ paymentId: order_id });
            if (order) {
                order.paymentStatus = 'completed';
                await order.save();
                await PaymentHistory.create({
                    user: order.user,
                    order: order._id,
                    razorpayOrderId: order_id,
                    razorpayPaymentId: payment_id,
                    amount: order.totalAmount,
                    status: 'completed',
                });
                return res.json({ status: 'success', message: 'Payment verified successfully' });
            }
        }
        res.status(400).json({ status: 'failure', message: 'Payment verification failed' });
    } catch (err) {
        res.status(500).json({ message: 'Error verifying payment', error: err.message });
    }
});

app.get('/api/payment/history', protect, async (req, res) => {
    try {
        const history = await PaymentHistory.find({ user: req.user._id }).sort({ createdAt: -1 });
        res.json(history);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching payment history' });
    }
});

// --------- Reviews Routes ----------
app.get('/api/products/:id/reviews', async (req, res) => {
    try {
        const reviews = await Review.find({ product: req.params.id }).populate('user', 'name');
        res.json(reviews);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching reviews' });
    }
});

app.post('/api/products/:id/reviews', protect, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        const review = await Review.create({
            product: req.params.id,
            user: req.user._id,
            rating,
            comment
        });
        res.status(201).json(review);
    } catch (err) {
        res.status(500).json({ message: 'Error adding review' });
    }
});

app.put('/api/products/:id/reviews/:reviewId', protect, async (req, res) => {
    try {
        const { rating, comment } = req.body;
        const review = await Review.findOne({ _id: req.params.reviewId, user: req.user._id, product: req.params.id });
        if (!review) return res.status(404).json({ message: 'Review not found or you do not have permission' });

        if (rating) review.rating = rating;
        if (comment) review.comment = comment;
        await review.save();
        res.json(review);
    } catch (err) {
        res.status(500).json({ message: 'Error editing review' });
    }
});

app.delete('/api/products/:id/reviews/:reviewId', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const review = await Review.findOne({ _id: req.params.reviewId, user: req.user._id, product: req.params.id });
        if (!review) return res.status(404).json({ message: 'Review not found or you do not have permission' });

        await review.deleteOne();
        res.json({ message: 'Review deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting review' });
    }
});

// --------- Addresses Routes ----------
app.get('/api/addresses', protect, async (req, res) => {
    try {
        const addresses = await Address.find({ user: req.user._id }).sort({ isDefault: -1 });
        res.json(addresses);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching addresses' });
    }
});

app.post('/api/addresses', protect, async (req, res) => {
    try {
        const { name, street, city, state, pincode, phone, isDefault = false } = req.body;
        const newAddress = await Address.create({
            user: req.user._id,
            name, street, city, state, pincode, phone, isDefault
        });
        res.status(201).json(newAddress);
    } catch (err) {
        res.status(500).json({ message: 'Error adding address' });
    }
});

app.put('/api/addresses/:id', protect, async (req, res) => {
    try {
        const { name, street, city, state, pincode, phone, isDefault } = req.body;
        const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
        if (!address) return res.status(404).json({ message: 'Address not found or you do not have permission' });

        if (name) address.name = name;
        if (street) address.street = street;
        if (city) address.city = city;
        if (state) address.state = state;
        if (pincode) address.pincode = pincode;
        if (phone) address.phone = phone;
        if (typeof isDefault !== 'undefined') address.isDefault = isDefault;

        await address.save();
        res.json(address);
    } catch (err) {
        res.status(500).json({ message: 'Error updating address' });
    }
});

app.delete('/api/addresses/:id', protect, async (req, res) => {
    try {
        const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
        if (!address) return res.status(404).json({ message: 'Address not found or you do not have permission' });

        await address.deleteOne();
        res.json({ message: 'Address deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting address' });
    }
});

// --------- Seller Routes ----------
app.get('/api/seller/categories-and-subcategories', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const getNestedSubcategories = async (parentId) => {
            const children = await Subcategory.find({ parent: parentId }).sort({ name: 1 });
            return await Promise.all(children.map(async (child) => ({
                id: child._id,
                name: child.name,
                children: await getNestedSubcategories(child._id),
            })));
        };

        const categories = await Category.find({}).sort({ name: 1 });

        const responseData = await Promise.all(categories.map(async (category) => {
            const subcategories = await Subcategory.find({ category: category._id, isTopLevel: true }).sort({ name: 1 });
            const nestedSubcategories = await Promise.all(subcategories.map(async (sub) => ({
                id: sub._id,
                name: sub.name,
                children: await getNestedSubcategories(sub._id),
            })));
            return {
                id: category._id,
                name: category.name,
                subcategories: nestedSubcategories,
            };
        }));

        res.json(responseData);
    } catch (err) {
        console.error("Error fetching categories and subcategories for seller:", err);
        res.status(500).json({ message: 'Error fetching categories and subcategories', error: err.message });
    }
});

app.get('/api/seller/products', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const products = await Product.find({ seller: req.user._id }).populate('seller', 'name email phone pincodes').populate('subcategory', 'name image').populate('category', 'name image');
        res.json(products);
    } catch (error) {
        console.error("Seller products error:", error);
        res.status(500).json({ message: 'Error fetching seller products' });
    }
});

// Updated POST endpoint to handle the new form structure
app.post('/api/seller/products', protect, authorizeRole('seller', 'admin'), checkSellerApproved, upload.array('images', 10), async (req, res) => {
    try {
        const { 
            productTitle, brand, sku, category, subcategory, childCategory, 
            mrp, sellingPrice, stockQuantity, unit, minOrderQty, 
            shortDescription, fullDescription, videoLink,
            specifications, colors, sizes, storages,
            shippingWeight, shippingLength, shippingWidth, shippingHeight, shippingType,
            warranty, returnPolicy, tags
        } = req.body;

        // Validation for required fields
        if (!productTitle || !sellingPrice || !category || !unit || !stockQuantity) {
            return res.status(400).json({ message: 'Product title, selling price, stock, category, and unit are required.' });
        }

        const parsedSellingPrice = parseFloat(sellingPrice);
        const parsedMrp = mrp ? parseFloat(mrp) : null;
        if (parsedMrp && parsedMrp < parsedSellingPrice) {
            return res.status(400).json({ message: 'MRP cannot be less than the selling price.' });
        }

        // Handle image uploads
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'At least one image is required.' });
        }
        const images = req.files.map(file => ({
            url: file.path,
            publicId: file.filename,
        }));

        // Handle dynamic specifications, variants, and other data
        const parsedSpecifications = specifications ? JSON.parse(specifications) : {};
        const parsedTags = tags ? JSON.parse(tags) : [];
        const parsedVariants = {
            colors: colors ? JSON.parse(colors) : [],
            sizes: sizes ? JSON.parse(sizes) : [],
            storages: storages ? JSON.parse(storages) : [],
        };
        const parsedShippingDetails = {
            weight: shippingWeight ? parseFloat(shippingWeight) : null,
            dimensions: {
                length: shippingLength ? parseFloat(shippingLength) : null,
                width: shippingWidth ? parseFloat(shippingWidth) : null,
                height: shippingHeight ? parseFloat(shippingHeight) : null,
            },
            shippingType: shippingType || 'Free',
        };
        const parsedOtherInfo = {
            warranty: warranty || null,
            returnPolicy: returnPolicy || null,
            tags: parsedTags,
        };

        const finalSubcategory = childCategory || subcategory;
        
        const product = await Product.create({
            name: productTitle,
            sku,
            brand,
            category,
            subcategory: finalSubcategory,
            originalPrice: parsedMrp,
            price: parsedSellingPrice,
            stock: parseInt(stockQuantity),
            unit,
            minOrderQty: minOrderQty ? parseInt(minOrderQty) : 1,
            shortDescription,
            fullDescription,
            images,
            videoLink,
            specifications: parsedSpecifications,
            variants: parsedVariants,
            shippingDetails: parsedShippingDetails,
            otherInformation: parsedOtherInfo,
            seller: req.user._id,
        });

        res.status(201).json(product);
    } catch (err) {
        console.error('Create product error:', err);
        res.status(500).json({ message: 'Error creating product', error: err.message });
    }
});

app.put('/api/seller/products/:id', protect, authorizeRole('seller', 'admin'), checkSellerApproved, upload.array('images', 5), async (req, res) => {
    try {
        const { name, description, brand, originalPrice, price, stock, category, subcategory, childSubcategory, specifications, imagesToDelete, unit } = req.body;
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });
        if (req.user.role === 'seller' && product.seller.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Access denied: You do not own this product' });
        }

        const parsedPrice = price ? parseFloat(price) : product.price;
        const parsedOriginalPrice = originalPrice ? parseFloat(originalPrice) : product.originalPrice;
        if (parsedOriginalPrice && parsedOriginalPrice < parsedPrice) {
            return res.status(400).json({ message: 'Original price cannot be less than the discounted price.' });
        }

        if (imagesToDelete) {
            const idsToDelete = Array.isArray(imagesToDelete) ? idsToDelete : [imagesToDelete];
            await Promise.all(idsToDelete.map(publicId => cloudinary.uploader.destroy(publicId)));
            product.images = product.images.filter(img => !idsToDelete.includes(img.publicId));
        }
        if (req.files && req.files.length > 0) {
            const newImages = req.files.map(file => ({ url: file.path, publicId: file.filename }));
            product.images.push(...newImages);
        }
        if (name) product.name = name;
        if (description) product.description = description;
        if (brand) product.brand = brand;
        if (parsedOriginalPrice) product.originalPrice = parsedOriginalPrice;
        if (parsedPrice) product.price = parsedPrice;
        if (stock) product.stock = stock;
        if (unit) product.unit = unit;
        if (category) product.category = category;

        const finalSubcategory = childSubcategory || subcategory;
        if (finalSubcategory) product.subcategory = finalSubcategory;

        if (specifications) product.specifications = JSON.parse(specifications);
        await product.save();
        res.json(product);
    } catch (err) {
        console.error('Update product error:', err);
        res.status(500).json({ message: 'Error updating product', error: err.message });
    }
});

app.delete('/api/seller/products/:id', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });
        if (req.user.role === 'seller' && product.seller.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Access denied: You do not own this product' });
        }
        await Promise.all(product.images.map(img => cloudinary.uploader.destroy(img.publicId)));
        await product.deleteOne();
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// --------- Admin Routes ----------
app.get('/api/admin/users', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const users = await User.find({ role: 'user' }).select('-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching users' });
    }
});

app.get('/api/admin/sellers', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const sellers = await User.find({ role: 'seller' }).select('-password');
        res.json(sellers);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching sellers' });
    }
});

app.put('/api/admin/users/:id/role', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { role, approved } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (role) user.role = role;
        if (typeof approved !== 'undefined') user.approved = approved;
        await user.save();
        res.json({ message: 'User role updated successfully', user });
    } catch (err) {
        res.status(500).json({ message: 'Error updating user role' });
    }
});

app.delete('/api/admin/users/:id', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        await user.deleteOne();
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting user' });
    }
});

app.get('/api/admin/orders', protect, authorizeRole('admin', 'seller'), async (req, res) => {
    try {
        const filter = {};
        if (req.user.role === 'seller') {
            filter.seller = req.user._id;
        }

        const orders = await Order.find(filter)
            .populate('user', 'name email phone')
            .populate('seller', 'name email')
            .populate('orderItems.product', 'name images price')
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching all orders' });
    }
});

app.put('/api/admin/orders/:id/status', protect, authorizeRole('admin', 'seller'), async (req, res) => {
    try {
        const { status } = req.body;
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (req.user.role === 'seller' && order.seller.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Access denied' });
        }
        order.deliveryStatus = status;
        order.history.push({ status: status });
        await order.save();
        res.json(order);
    } catch (err) {
        res.status(500).json({ message: 'Error updating order status', error: err.message });
    }
});

// New Banner Routes
app.post('/api/admin/banners', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
    try {
        const { title, link, isActive, position, type } = req.body;
        const file = req.file;
        if (!file) {
            return res.status(400).json({ message: 'Media file (image or video) is required' });
        }
        const bannerData = {
            title: title || 'New Banner',
            link: link || '',
            isActive: isActive === 'true',
            position: position || 'top',
            type: type || (file.mimetype.startsWith('video') ? 'video' : 'image'),
        };
        if (bannerData.type === 'image') {
            bannerData.image = { url: file.path, publicId: file.filename };
        } else if (bannerData.type === 'video') {
            bannerData.video = { url: file.path, publicId: file.filename };
        }
        const newBanner = await Banner.create(bannerData);
        res.status(201).json(newBanner);
    } catch (err) {
        console.error('Create banner error:', err);
        res.status(500).json({ message: 'Error creating banner', error: err.message });
    }
});

app.get('/api/banners/hero', async (req, res) => {
    try {
        const banners = await Banner.find({ isActive: true, position: 'top' }).sort({ createdAt: -1 });
        res.json(banners);
    } catch (err) {
        console.error('Error fetching hero banners:', err);
        res.status(500).json({ message: 'Error fetching hero banners' });
    }
});

app.get('/api/banners/dynamic', async (req, res) => {
    try {
        const banners = await Banner.find({ isActive: true, position: { $in: ['middle', 'bottom'] } }).sort({ createdAt: -1 });
        res.json(banners);
    } catch (err) {
        console.error('Error fetching dynamic banners:', err);
        res.status(500).json({ message: 'Error fetching dynamic banners' });
    }
});

app.get('/api/admin/banners', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const banners = await Banner.find().sort({ createdAt: -1 });
        res.json(banners);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching banners', error: err.message });
    }
});

app.put('/api/admin/banners/:id', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
    try {
        const { title, link, isActive, position, type } = req.body;
        const banner = await Banner.findById(req.params.id);
        if (!banner) return res.status(404).json({ message: 'Banner not found' });
        const file = req.file;
        if (file) {
            if (banner.image && banner.image.publicId) {
                await cloudinary.uploader.destroy(banner.image.publicId);
            }
            if (banner.video && banner.video.publicId) {
                await cloudinary.uploader.destroy(banner.video.publicId, { resource_type: 'video' });
            }
            if (file.mimetype.startsWith('video')) {
                banner.video = { url: file.path, publicId: file.filename };
                banner.image = null;
            } else {
                banner.image = { url: file.path, publicId: file.filename };
                banner.video = null;
            }
            banner.type = file.mimetype.startsWith('video') ? 'video' : 'image';
        }
        if (title) banner.title = title;
        if (link) banner.link = link;
        if (typeof isActive !== 'undefined') banner.isActive = isActive === 'true';
        if (position) banner.position = position;
        if (type) banner.type = type;
        await banner.save();
        res.json(banner);
    } catch (err) {
        console.error('Update banner error:', err);
        res.status(500).json({ message: 'Error updating banner', error: err.message });
    }
});

app.delete('/api/admin/banners/:id', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);
        if (!banner) return res.status(404).json({ message: 'Banner not found' });
        if (banner.image && banner.image.publicId) await cloudinary.uploader.destroy(banner.image.publicId);
        if (banner.video && banner.video.publicId) await cloudinary.uploader.destroy(banner.video.publicId, { resource_type: 'video' });
        await banner.deleteOne();
        res.json({ message: 'Banner deleted successfully' });
    } catch (err) {
        console.error('Delete banner error:', err);
        res.status(500).json({ message: 'Error deleting banner', error: err.message });
    }
});

// New Splash Routes
app.post('/api/admin/splash', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
    try {
        const { title, link, type, startDate, endDate, isActive } = req.body;
        const file = req.file;
        if (!file) {
            return res.status(400).json({ message: 'Media file (image or video) is required' });
        }
        if (type === 'scheduled' && (!startDate || !endDate)) {
            return res.status(400).json({ message: 'Scheduled splash screens require a start and end date.' });
        }
        const splashData = {
            title: title || 'New Splash',
            link: link || '',
            type: type || 'default',
            isActive: isActive === 'true',
        };
        if (splashData.type === 'video') {
            splashData.video = { url: file.path, publicId: file.filename };
        } else {
            splashData.image = { url: file.path, publicId: file.filename };
        }
        const newSplash = await Splash.create(splashData);
        res.status(201).json(newSplash);
    } catch (err) {
        console.error('Create splash error:', err);
        res.status(500).json({ message: 'Error creating splash screen', error: err.message });
    }
});

app.get('/api/admin/splash', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const splashes = await Splash.find().sort({ createdAt: -1 });
        res.json(splashes);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching splash screens', error: err.message });
    }
});

app.put('/api/admin/splash/:id', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
    try {
        const { title, link, type, startDate, endDate, isActive } = req.body;
        const splash = await Splash.findById(req.params.id);
        if (!splash) return res.status(404).json({ message: 'Splash screen not found' });
        const file = req.file;
        if (file) {
            if (splash.image && splash.image.publicId) {
                await cloudinary.uploader.destroy(splash.image.publicId);
            }
            if (splash.video && splash.video.publicId) {
                await cloudinary.uploader.destroy(splash.video.publicId, { resource_type: 'video' });
            }
            if (file.mimetype.startsWith('video')) {
                splash.video = { url: file.path, publicId: file.filename };
                splash.image = null;
            } else {
                splash.image = { url: file.path, publicId: file.filename };
                splash.video = null;
            }
        }
        if (title) splash.title = title;
        if (link) splash.link = link;
        if (typeof isActive !== 'undefined') splash.isActive = isActive === 'true';
        if (type) splash.type = type;
        if (type === 'scheduled') {
            if (!startDate || !endDate) {
                return res.status(400).json({ message: 'Scheduled splash screens require a start and end date.' });
            }
            splash.startDate = startDate;
            splash.endDate = endDate;
        } else {
            splash.startDate = undefined;
            splash.endDate = undefined;
        }
        await splash.save();
        res.json(splash);
    } catch (err) {
        console.error('Update splash error:', err);
        res.status(500).json({ message: 'Error updating splash screen', error: err.message });
    }
});

app.delete('/api/admin/splash/:id', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const splash = await Splash.findById(req.params.id);
        if (!splash) return res.status(404).json({ message: 'Splash screen not found' });
        if (splash.image && splash.image.publicId) await cloudinary.uploader.destroy(splash.image.publicId);
        if (splash.video && splash.video.publicId) await cloudinary.uploader.destroy(splash.video.publicId, { resource_type: 'video' });
        await splash.deleteOne();
        res.json({ message: 'Splash screen deleted successfully' });
    } catch (err) {
        console.error('Delete splash error:', err);
        res.status(500).json({ message: 'Error deleting splash screen', error: err.message });
    }
});

app.get('/api/splash', async (req, res) => {
    try {
        const allSplashes = await Splash.find({ isActive: true });
        const defaultSplash = allSplashes.find(s => s.type === 'default');
        const scheduledSplashes = allSplashes.filter(s => s.type === 'scheduled');
        res.json({ defaultSplash, scheduledSplashes });
    } catch (err) {
        console.error('Error fetching splash screens:', err);
        res.status(500).json({ message: 'Error fetching splash screens' });
    }
});

// --------- Reports Routes ----------
app.get('/api/admin/reports/sales', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const salesReport = await Order.aggregate([
            { $match: { deliveryStatus: 'Delivered', paymentStatus: 'completed' } },
            { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, totalSales: { $sum: "$totalAmount" }, totalOrders: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        res.json(salesReport);
    } catch (err) {
        res.status(500).json({ message: 'Error generating sales report', error: err.message });
    }
});

app.get('/api/admin/reports/products', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const topProducts = await Order.aggregate([
            { $match: { deliveryStatus: 'Delivered' } },
            { $unwind: "$orderItems" },
            { $group: { _id: "$orderItems.product", totalQuantitySold: { $sum: "$orderItems.qty" }, totalRevenue: { $sum: { $multiply: ["$orderItems.price", "$orderItems.qty"] } } } },
            { $sort: { totalQuantitySold: -1 } },
            { $limit: 10 },
            { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'productInfo' } },
            { $unwind: "$productInfo" }
        ]);
        res.json(topProducts);
    } catch (err) {
        res.status(500).json({ message: 'Error generating top products report', error: err.message });
    }
});

// --------- Other Routes ----------
app.get('/', (req, res) => {
    res.send('E-Commerce Backend API is running!');
});

const IP = '0.0.0.0';
const PORT = process.env.PORT || 5001;

app.listen(PORT, IP, () => {
    console.log(`🚀 Server running on http://${IP}:${PORT}`);
});
