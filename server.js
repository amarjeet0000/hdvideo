// server.js - Full E-Commerce Backend (Patched with Time Slot Availability)
// ... (previous features)
// 9. ### NEW: Added comprehensive Admin Dashboard Statistics endpoint.
// 10. ### NEW: Added Payment Method statistics (COD vs Online) to the dashboard API.

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
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

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

        try {
            const categoryCount = await Category.countDocuments();
            if (categoryCount === 0) {
                console.log('No categories found. Creating default categories...');
                const defaultCategories = [
                    { name: 'Fruits', slug: 'fruits', type: 'product' },
                    { name: 'Vegetables', slug: 'vegetables', type: 'product' },
                    { name: 'Clothing', slug: 'clothing', type: 'product' },
                    { name: 'Home Services', slug: 'home-services', type: 'service' },
                    { name: 'Transport', slug: 'transport', type: 'service' },
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
            console.error('Error creating default categories:', err.message); 
        }
    })
    .catch(err => console.error('❌ MongoDB connection error:', err.message)); 

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

const productUpload = upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'video', maxCount: 1 } 
]);

// --------- Notifications ----------
async function sendWhatsApp(to, message) {
    try {
        if (!to || !process.env.TWILIO_ACCOUNT_SID) {
            console.log(`WhatsApp not configured. Message for ${to}: ${message}`);
            return;
        }
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


// #############################################
// ## NEW HELPER FUNCTION ADDED HERE
// #############################################
/**
 * NEW HELPER FUNCTION
 * Generates a unique SKU based on category, product name, and random characters.
 */
function generateUniqueSku(categoryId, productName) {
    const catPart = categoryId.toString().slice(-4).toUpperCase(); // Use last 4 chars of Category ID
    let prodPart = productName.substring(0, 3).toUpperCase();
    prodPart = prodPart.replace(/[^A-Z0-9]/g, 'X'); // Clean any special characters
    
    // Use the crypto module (already imported) to add 6 random hex characters
    const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase(); 
    
    return `${catPart}-${prodPart}-${randomPart}`;
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
    passwordResetOTP: String,
    passwordResetOTPExpire: Date,
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['product', 'service'], default: 'product' }, 
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

const productSchema = new mongoose.Schema({
    name: String,
    brand: { type: String, default: 'Unbranded' },
    sku: String, 
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    childCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null }, 
    originalPrice: Number, 
    price: Number, 
    stock: { type: Number, default: 10 },
    unit: {
        type: String,
        enum: ['kg', '100g', '250g', '500g', 'L', 'ml', 'pcs', 'pack', 'piece', 'bunch', 'packet', 'dozen', 'bag', '50g'],
        required: false, // No longer required globally since services don't have it
    },
    minOrderQty: { type: Number, default: 1 }, 
    shortDescription: String, 
    fullDescription: String, 
    images: [{
        url: String,
        publicId: String
    }],
    videoLink: String, 
    uploadedVideo: {
        url: String,
        publicId: String
    },
    specifications: { type: Map, of: String, default: {} },
    variants: { type: Map, of: [String], default: {} },
    shippingDetails: { 
        weight: Number,
        dimensions: {
            length: Number,
            width: Number,
            height: Number,
        },
        shippingType: { type: String, enum: ['Free', 'Paid', 'COD Available'], default: 'Free' },
    },
    otherInformation: { 
        warranty: String,
        returnPolicy: {
            type: String,
            enum: ['Non-Returnable', 'Returnable', 'Replacement'],
            default: 'Non-Returnable'
        },
        tags: [String],
    },
    serviceDurationMinutes: { type: Number },
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


// ### MODIFIED: Booking Schema for Time Slots ###
const bookingSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    service: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    bookingStart: { type: Date, required: true }, 
    bookingEnd: { type: Date, required: true },  
    address: { type: String, required: true },
    status: {
        type: String,
        enum: ['Pending', 'Accepted', 'Rejected', 'Completed', 'Cancelled'],
        default: 'Pending'
    },
    notes: String,
}, { timestamps: true });
const Booking = mongoose.model('Booking', bookingSchema);


// ### NEW: AVAILABILITY SCHEMA ###
const timeSlotSchema = new mongoose.Schema({
    start: { type: String, required: true }, // e.g., "09:00"
    end: { type: String, required: true },   // e.g., "17:00"
}, { _id: false });

const dailyAvailabilitySchema = new mongoose.Schema({
    isActive: { type: Boolean, default: false },
    slots: [timeSlotSchema] 
}, { _id: false });

const customDateAvailabilitySchema = new mongoose.Schema({
    date: { type: Date, required: true }, 
    isActive: { type: Boolean, default: false }, 
    slots: [timeSlotSchema]
}, { _id: false });

const availabilitySchema = new mongoose.Schema({
    provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    days: {
        monday:    dailyAvailabilitySchema,
        tuesday:   dailyAvailabilitySchema,
        wednesday: dailyAvailabilitySchema,
        thursday:  dailyAvailabilitySchema,
        friday:    dailyAvailabilitySchema,
        saturday:  dailyAvailabilitySchema,
        sunday:    dailyAvailabilitySchema,
    },
    customDates: [customDateAvailabilitySchema]
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);


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

// --------- Category Routes ----------
app.get('/api/categories', async (req, res) => {
    try {
        const { active } = req.query;
        const filter = {};
        if (typeof active !== 'undefined') filter.isActive = active === 'true';
        const categories = await Category.find(filter).sort({ name: 1 }).select('name slug isActive image type');
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
        const categories = await Category.find(filter).sort({ name: 1 }).select('name slug isActive image type');
        res.json(categories);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching categories', error: err.message });
    }
});

app.post('/api/admin/categories', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
    try {
        const { name, type } = req.body; 
        if (!name) return res.status(400).json({ message: 'Category name is required' });
        const slug = name.toLowerCase().replace(/[^a-z09]+/g, '-').replace(/^-+|-+$/g, '');
        const category = await Category.create({
            name, 
            slug,
            type: type || 'product', 
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
        const { name, isActive, type } = req.body; 
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
        if (type) category.type = type; 
        
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


// --------- Subcategory Routes ----------
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
        console.error('Register error:', err.message); 
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
                return res.status(403).json({ message: 'User role cannot log in with email. Please use phone number.' });
            }
        } else if (phone) {
            user = await User.findOne({ phone });
            if (user && (user.role === 'seller' || user.role === 'admin')) {
                return res.status(403).json({ message: 'Seller/Admin roles must log in with email.' });
            }
        }

        if (!user) return res.status(401).json({ message: 'Invalid credentials' });

        if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: 'Invalid credentials' });

        if (user.role === 'seller' && !user.approved) return res.status(403).json({ message: 'Seller account awaiting admin approval' });

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, pincodes: user.pincodes, approved: user.approved } });
    } catch (err) {
        console.error('Login error:', err.message); 
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
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.passwordResetOTP = await bcrypt.hash(otp, 10);
        user.passwordResetOTPExpire = Date.now() + 10 * 60 * 1000;
        await user.save();
        
        const message = `Namaste! Your OTP for password reset is ${otp}. This OTP is valid for 10 minutes.`;
        await sendWhatsApp(user.phone, message);

        res.status(200).json({ message: 'OTP sent to your WhatsApp number' });
    } catch (err) {
        console.error('Forgot password error:', err.message); 
        res.status(500).json({ message: 'Error processing forgot password request' });
    }
});

app.post('/api/auth/reset-password-with-otp', async (req, res) => {
    try {
        const { phone, otp, newPassword } = req.body;
        if (!phone || !otp || !newPassword) {
            return res.status(400).json({ message: 'Phone, OTP, and new password are required' });
        }

        const user = await User.findOne({
            phone,
            passwordResetOTPExpire: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ message: 'User not found or OTP has expired' });
        }
        
        const isMatch = await bcrypt.compare(otp, user.passwordResetOTP);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid OTP' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.passwordResetOTP = undefined;
        user.passwordResetOTPExpire = undefined;
        await user.save();

        res.status(200).json({ message: 'Password has been reset successfully' });
    } catch (err) {
        console.error('Error resetting password with OTP:', err.message);
        res.status(500).json({ message: 'Error resetting password' });
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
        if (categoryId && categoryId !== 'null') filter.category = categoryId;
        if (brand) filter.brand = { $regex: brand, $options: 'i' };
        if (subcategoryId) filter.subcategory = subcategoryId;
        if (sellerId) filter.seller = sellerId;
        if (excludeProductId) filter._id = { $ne: excludeProductId };

        const products = await Product.find(filter).populate('seller', 'name email phone pincodes').populate('subcategory', 'name image').populate('category', 'name image');
        res.json(products);
    } catch (err) {
        console.error("Get Products Error:", err.message); 
        res.status(500).json({ message: 'Error fetching products' });
    }
});

app.get('/api/products/trending', async (req, res) => {
    try {
        const trendingProducts = await Product.find({ isTrending: true }).limit(10).populate('seller', 'name email').populate('category', 'name').populate('subcategory', 'name');
        res.json(trendingProducts);
    } catch (err) {
        console.error("Get Trending Products Error:", err.message); 
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


// --------- Cart, Wishlist, Likes, Orders Routes ----------
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
        const { productId, qty = 1, pincode } = req.body;
        const product = await Product.findById(productId).populate('seller', 'pincodes');
        if (!product) return res.status(404).json({ message: 'Product not found' });

        if (pincode && !product.seller.pincodes.includes(pincode)) {
            return res.status(400).json({ message: "Sorry, delivery not available at your location" });
        }

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
        console.error('Like product error:', err.message); 
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
        console.error('Unlike product error:', err.message); 
        res.status(500).json({ message: 'Error unliking product' });
    }
});

app.post('/api/orders', protect, async (req, res) => {
    try {
        const { shippingAddressId, paymentMethod, couponCode } = req.body;
        
        const cart = await Cart.findOne({ user: req.user._id }).populate({
            path: 'items.product',
            populate: {
                path: 'seller',
                select: 'pincodes name phone'
            }
        });

        if (!cart || cart.items.length === 0) {
            return res.status(400).json({ message: 'Cart is empty' });
        }
        const shippingAddress = await Address.findById(shippingAddressId);
        if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });

        for (const item of cart.items) {
            if (!item.product || !item.product.seller) {
                return res.status(400).json({
                    message: `An item in your cart is no longer available. Please remove it to continue.`
                });
            }
            const product = item.product;
            if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
                return res.status(400).json({
                    message: `Sorry, delivery not available at your location for the product: "${product.name}"`
                });
            }
        }

        const ordersBySeller = new Map();
        for (const item of cart.items) {
            const product = item.product;
            if (product.stock < item.qty) {
                return res.status(400).json({ message: `Insufficient stock for product: ${product.name}` });
            }

            const sellerId = product.seller._id.toString();
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
                receipt: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
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
            
            const orderIdShort = order._id.toString().slice(-6);
            const userMessage = `✅ Your order #${orderIdShort} has been successfully placed! You will be notified once it's shipped.`;
            const sellerMessage = `🎉 New Order!\nYou've received a new order #${orderIdShort} from ${req.user.name}. Please process it soon.`;
            
            await sendWhatsApp(req.user.phone, userMessage);
            await sendWhatsApp(sellerData.seller.phone, sellerMessage);
            await notifyAdmin(`Admin Alert: New order #${orderIdShort} placed.`);

            for(const item of sellerData.orderItems) {
                await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
            }
        }

        await Cart.deleteOne({ user: req.user._id });

        res.status(201).json({
            message: 'Orders created successfully',
            orders: createdOrders.map(o => o._id),
            razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount } : undefined,
            key_id: process.env.RAZORPAY_KEY_ID,
            user: { name: req.user.name, email: req.user.email, phone: req.user.phone }
        });

    } catch (err) {
        console.error('Create order error:', err.message); 
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ message: 'Error creating order', error: err.message });
    }
});

app.get('/api/orders', protect, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id })
            .populate({
                path: 'orderItems.product',
                select: 'name images price originalPrice unit category',
                populate: {
                    path: 'category',
                    select: 'name'
                }
            })
            .populate('seller', 'name email')
            .sort({ createdAt: -1 })
            .lean();

        const ordersWithDisplayImage = orders.map(order => {
            let image = null;
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
                select: 'name images price originalPrice unit',
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
        const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).populate('seller', 'phone');
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
        
        const orderIdShort = order._id.toString().slice(-6);
        const sellerMessage = `Order Cancellation: Order #${orderIdShort} has been cancelled by the customer.`;
        await sendWhatsApp(order.seller.phone, sellerMessage);
        await notifyAdmin(`Admin Alert: Order #${orderIdShort} cancelled by user.`);
        
        res.json({ message: 'Order cancelled successfully', order });
    } catch (err) {
        res.status(500).json({ message: 'Error cancelling order' });
    }
});


// ##################################################################
// ## BOOKING & AVAILABILITY ROUTES
// ##################################################################
app.get('/api/seller/availability', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        let availability = await Availability.findOne({ provider: req.user._id });

        if (!availability) {
            const defaultDay = { isActive: false, slots: [{ start: "09:00", end: "17:00" }] };
            availability = await Availability.create({
                provider: req.user._id,
                days: {
                    monday: defaultDay,
                    tuesday: defaultDay,
                    wednesday: defaultDay,
                    thursday: defaultDay,
                    friday: defaultDay,
                    saturday: defaultDay,
                    sunday: defaultDay,
                }
            });
        }
        res.json(availability);
    } catch (err) {
        console.error('Get availability error:', err.message);
        res.status(500).json({ message: 'Error fetching availability', error: err.message });
    }
});

app.put('/api/seller/availability', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const { days, customDates } = req.body;
        const availability = await Availability.findOneAndUpdate(
            { provider: req.user._id },
            { 
                provider: req.user._id,
                days: days, 
                customDates: customDates || [] 
            },
            { new: true, upsert: true, runValidators: true }
        );
        res.status(200).json(availability);
    } catch (err) {
        console.error('Update availability error:', err.message);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: 'Validation error: Invalid slot data', error: err.message });
        }
        res.status(500).json({ message: 'Error updating availability', error: err.message });
    }
});

app.get('/api/services/:id/availability', async (req, res) => {
    try {
        const { date } = req.query; 
        if (!date) {
            return res.status(400).json({ message: 'Date query parameter (YYYY-MM-DD) is required.' });
        }

        const service = await Product.findById(req.params.id).populate('category'); // <<< Populate category here
        if (!service || !service.seller) {
            return res.status(404).json({ message: 'Service or service provider not found.' });
        }

        if (service.category.type !== 'service' || !service.serviceDurationMinutes) {
            return res.status(400).json({ message: 'This product is not a bookable service with a valid duration.' });
        }

        const providerId = service.seller;
        const duration = service.serviceDurationMinutes;
        const requestedDate = new Date(`${date}T00:00:00.000Z`); 
        const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][requestedDate.getUTCDay()];

        const availability = await Availability.findOne({ provider: providerId });
        if (!availability) {
            return res.status(404).json({ message: 'This provider has not set up their availability.' });
        }

        let scheduleForDay = availability.days[dayOfWeek]; 
        const customDate = availability.customDates.find(d => new Date(d.date).toDateString() === requestedDate.toDateString());

        if (customDate) {
            scheduleForDay = customDate; 
        }

        if (!scheduleForDay || !scheduleForDay.isActive) {
            return res.json([]); 
        }

        const allPossibleSlots = [];
        const slotDurationMillis = duration * 60 * 1000;

        for (const block of scheduleForDay.slots) {
            const [startHour, startMin] = block.start.split(':').map(Number);
            const [endHour, endMin] = block.end.split(':').map(Number);

            let currentSlotTime = new Date(requestedDate);
            currentSlotTime.setUTCHours(startHour, startMin, 0, 0);

            let blockEndTime = new Date(requestedDate);
            blockEndTime.setUTCHours(endHour, endMin, 0, 0);

            while (true) {
                const slotEndTime = new Date(currentSlotTime.getTime() + slotDurationMillis);
                
                if (slotEndTime > blockEndTime) {
                    break;
                }
                
                allPossibleSlots.push(new Date(currentSlotTime)); 
                currentSlotTime = slotEndTime; 
            }
        }

        const dayStart = new Date(requestedDate);
        const dayEnd = new Date(requestedDate);
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1); 

        const existingBookings = await Booking.find({
            provider: providerId,
            status: { $nin: ['Rejected', 'Cancelled'] }, 
            bookingStart: {
                $gte: dayStart,
                $lt: dayEnd
            }
        }).select('bookingStart bookingEnd');
        
        const availableSlots = allPossibleSlots.filter(slotStart => {
            const slotEnd = new Date(slotStart.getTime() + slotDurationMillis);
            
            const isBooked = existingBookings.some(booking => {
                return (booking.bookingStart < slotEnd) && (booking.bookingEnd > slotStart);
            });

            return !isBooked; 
        });

        res.json(availableSlots.map(date => date.toISOString()));

    } catch (err) {
        console.error('Get availability slots error:', err.message);
        res.status(500).json({ message: 'Error calculating available slots', error: err.message });
    }
});


app.post('/api/bookings', protect, async (req, res) => {
    try {
        const { serviceId, bookingStartISO, address, notes } = req.body;
        
        if (!serviceId || !bookingStartISO || !address) {
            return res.status(400).json({ message: 'Service ID, booking start time, and address are required.' });
        }

        const service = await Product.findById(serviceId).populate('seller').populate('category'); // Need category to check type
        if (!service) return res.status(404).json({ message: 'Service not found.' });
        if (service.category.type !== 'service' || !service.serviceDurationMinutes) {
             return res.status(400).json({ message: 'This product is not a bookable service.' });
        }
        if (!service.seller) return res.status(404).json({ message: 'Service provider not found.' });

        const providerId = service.seller._id;
        const duration = service.serviceDurationMinutes;
        const bookingStart = new Date(bookingStartISO);
        const bookingEnd = new Date(bookingStart.getTime() + duration * 60 * 1000);

        const conflictingBooking = await Booking.findOne({
            provider: providerId,
            status: { $nin: ['Rejected', 'Cancelled'] },
            $or: [
                { bookingStart: { $gte: bookingStart, $lt: bookingEnd } },
                { bookingEnd: { $gt: bookingStart, $lte: bookingEnd } },
                { bookingStart: { $lte: bookingStart }, bookingEnd: { $gte: bookingEnd } }
            ]
        });

        if (conflictingBooking) {
            return res.status(409).json({ message: 'Sorry, this time slot has just been booked. Please select another slot.' });
        }
        
        const newBooking = await Booking.create({
            user: req.user._id,
            provider: providerId,
            service: serviceId,
            bookingStart: bookingStart,
            bookingEnd: bookingEnd,
            address,
            notes,
        });

        const providerPhone = service.seller.phone;
        const formattedDate = bookingStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        const message = `🎉 New Booking Request!\n\nService: ${service.name}\nUser: ${req.user.name}\nSlot: ${formattedDate}.\nPlease log in to your panel to accept or reject.`;
        await sendWhatsApp(providerPhone, message);

        res.status(201).json(newBooking);
    } catch (err) {
        console.error('Create booking error:', err.message); 
        res.status(500).json({ message: 'Error creating booking.' });
    }
});

app.put('/api/bookings/:id/status', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const { status } = req.body;
        const booking = await Booking.findById(req.params.id).populate('user service');
        if (!booking) return res.status(404).json({ message: 'Booking not found.' });

        if (req.user.role === 'seller' && booking.provider.toString() !== req.user._id.toString()) {
             return res.status(403).json({ message: 'Access denied.' });
        }

        booking.status = status;
        await booking.save();
        
        const userPhone = booking.user.phone;
        const formattedDate = booking.bookingStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        const message = `Booking Update!\n\nYour booking for "${booking.service.name}" on ${formattedDate} has been ${status}.`;
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

// --------- Reviews & Addresses Routes ----------
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
        console.error("Error fetching categories and subcategories for seller:", err.message); 
        res.status(500).json({ message: 'Error fetching categories and subcategories', error: err.message });
    }
});

// ### ROUTE 1: FIX APPLIED HERE ###
app.get('/api/seller/products', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const products = await Product.find({ seller: req.user._id })
            .populate('seller', 'name email phone pincodes')
            .populate('subcategory', 'name image')
            // <<< FIX: Added 'type', 'slug', 'isActive' so frontend model doesn't crash
            .populate('category', 'name slug type isActive image'); 
        res.json(products);
    } catch (error) {
        console.error("Seller products error:", error.message); 
        res.status(500).json({ message: 'Error fetching seller products' });
    }
});


// ... (POST /api/seller/products, POST /api/seller/products/bulk, PUT /api/seller/products/:id, DELETE /api/seller/products/:id are unchanged from last version) ...
app.post('/api/seller/products', protect, authorizeRole('seller', 'admin'), checkSellerApproved, productUpload, async (req, res) => {
    try {
        const { 
            productTitle, brand, category, subcategory, childCategory, 
            mrp, sellingPrice, stockQuantity, unit, minOrderQty, 
            shortDescription, fullDescription, videoLink,
            specifications, colors, sizes, storages,
            shippingWeight, shippingLength, shippingWidth, shippingHeight, shippingType,
            warranty, returnPolicy, tags,
            serviceDurationMinutes 
        } = req.body;

        if (!productTitle || !sellingPrice || !category || !stockQuantity) {
            return res.status(400).json({ message: 'Product title, selling price, stock, and category are required.' });
        }
        
        const parentCategory = await Category.findById(category);
        if (!parentCategory) {
            return res.status(404).json({ message: 'Selected category not found.' });
        }

        if (parentCategory.type === 'service') {
            if (!serviceDurationMinutes || parseInt(serviceDurationMinutes) <= 0) {
                return res.status(400).json({ message: 'Services must have a valid "Service Duration (in minutes)".' });
            }
        } else if (parentCategory.type === 'product') {
             if (!unit) {
                return res.status(400).json({ message: 'Products must have a "Unit" (e.g., kg, pcs).' });
            }
        }

        const newSku = generateUniqueSku(category, productTitle);

        const parsedSellingPrice = parseFloat(sellingPrice);
        const parsedMrp = mrp ? parseFloat(mrp) : null;
        if (parsedMrp && parsedMrp < parsedSellingPrice) {
            return res.status(400).json({ message: 'MRP cannot be less than the selling price.' });
        }

        if (!req.files.images || req.files.images.length === 0) {
            return res.status(400).json({ message: 'At least one image is required.' });
        }
        const images = req.files.images.map(file => ({
            url: file.path,
            publicId: file.filename,
        }));

        let uploadedVideo = null;
        if (req.files.video && req.files.video.length > 0) {
            const videoFile = req.files.video[0];
            uploadedVideo = {
                url: videoFile.path,
                publicId: videoFile.filename
            };
        }

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
            },
            shippingType: shippingType || 'Free',
        };
        const parsedOtherInfo = {
            warranty: warranty || null,
            returnPolicy: returnPolicy || 'Non-Returnable',
            tags: parsedTags,
        };

        const finalSubcategory = childCategory || subcategory;
        
        const product = await Product.create({
            name: productTitle,
            sku: newSku, 
            brand,
            category,
            subcategory: finalSubcategory,
            originalPrice: parsedMrp,
            price: parsedSellingPrice,
            stock: parseInt(stockQuantity),
            unit: parentCategory.type === 'product' ? unit : undefined, 
            minOrderQty: minOrderQty ? parseInt(minOrderQty) : 1,
            shortDescription,
            fullDescription,
            images,
            videoLink,
            uploadedVideo: uploadedVideo,
            specifications: parsedSpecifications,
            variants: parsedVariants,
            shippingDetails: parsedShippingDetails,
            otherInformation: parsedOtherInfo,
            seller: req.user._id,
            serviceDurationMinutes: parentCategory.type === 'service' ? parseInt(serviceDurationMinutes) : undefined, 
        });

        res.status(201).json(product);
    } catch (err) {
        console.error('Create product error:', err.message); 
        if (err.name === 'ValidationError') {
             return res.status(400).json({ message: 'Validation failed', error: err.message });
        }
        res.status(500).json({ message: 'Error creating product', error: err.message });
    }
});

app.post('/api/seller/products/bulk', protect, authorizeRole('seller', 'admin'), checkSellerApproved, upload.array('images', 100), async (req, res) => {
    try {
        const { products } = req.body;
        if (!products) {
            return res.status(400).json({ message: 'Products data is missing.' });
        }

        const productsData = JSON.parse(products);

        if (!Array.isArray(productsData) || productsData.length === 0) {
            return res.status(400).json({ message: 'Products data must be a non-empty array.' });
        }

        if (productsData.length > 10) {
            return res.status(400).json({ message: 'You can upload a maximum of 10 products at a time.' });
        }

        let fileIndex = 0;
        const productsToCreate = [];

        for (const productInfo of productsData) {
            const { productTitle, sellingPrice, stockQuantity, unit, category, imageCount } = productInfo;
            if (!productTitle || !sellingPrice || !stockQuantity || !unit || !category || imageCount === undefined) {
               return res.status(400).json({ message: `Missing required fields for product "${productTitle || 'Unknown'}". Ensure all products have title, price, stock, unit, category, and imageCount.` });
            }

            const productImages = req.files.slice(fileIndex, fileIndex + imageCount).map(file => ({
                url: file.path,
                publicId: file.filename
            }));
            
            fileIndex += imageCount;
            
            const newProduct = {
                name: productTitle,
                price: parseFloat(sellingPrice),
                sku: generateUniqueSku(category, productTitle), 
                stock: parseInt(stockQuantity),
                unit,
                category,
                seller: req.user._id,
                images: productImages,
                brand: productInfo.brand || 'Unbranded',
                originalPrice: productInfo.mrp ? parseFloat(productInfo.mrp) : undefined,
                shortDescription: productInfo.shortDescription || undefined,
                otherInformation: {
                    warranty: productInfo.warranty || null,
                    returnPolicy: productInfo.returnPolicy || 'Non-Returnable',
                    tags: productInfo.tags || []
                }
            };
            
            productsToCreate.push(newProduct);
        }
        
        const createdProducts = await Product.insertMany(productsToCreate);

        res.status(201).json({ message: `${createdProducts.length} products uploaded successfully.`, products: createdProducts });

    } catch (err) {
        console.error('Bulk create product error:', err.message); 
        if (req.files) {
            req.files.forEach(file => {
                cloudinary.uploader.destroy(file.filename);
            });
        }
        if (err.name === 'ValidationError') {
             return res.status(400).json({ message: 'Validation failed (perhaps an invalid returnPolicy value was used?).', error: err.message });
        }
        res.status(500).json({ message: 'Error creating products in bulk', error: err.message });
    }
});

app.put('/api/seller/products/:id', protect, authorizeRole('seller', 'admin'), checkSellerApproved, productUpload, async (req, res) => {
    try {
        const { name, description, brand, originalPrice, price, stock, category, subcategory, childSubcategory, specifications, imagesToDelete, unit, serviceDurationMinutes, returnPolicy } = req.body;
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
            const idsToDelete = Array.isArray(imagesToDelete) ? imagesToDelete : [imagesToDelete];
            await Promise.all(idsToDelete.map(publicId => cloudinary.uploader.destroy(publicId)));
            product.images = product.images.filter(img => !idsToDelete.includes(img.publicId));
        }

        if (req.files.images && req.files.images.length > 0) {
            const newImages = req.files.images.map(file => ({ url: file.path, publicId: file.filename }));
            product.images.push(...newImages);
        }
        
        if (req.files.video && req.files.video.length > 0) {
            const newVideoFile = req.files.video[0];
            if (product.uploadedVideo && product.uploadedVideo.publicId) {
                await cloudinary.uploader.destroy(product.uploadedVideo.publicId, { resource_type: 'video' });
            }
            product.uploadedVideo = {
                url: newVideoFile.path,
                publicId: newVideoFile.filename
            };
        }

        if (name) product.name = name;
        if (description) product.description = description;
        if (brand) product.brand = brand;
        if (parsedOriginalPrice) product.originalPrice = parsedOriginalPrice;
        if (parsedPrice) product.price = parsedPrice;
        if (stock) product.stock = stock;
        if (unit) product.unit = unit;
        if (category) product.category = category;
        if (returnPolicy) product.otherInformation.returnPolicy = returnPolicy;
        if (serviceDurationMinutes) product.serviceDurationMinutes = parseInt(serviceDurationMinutes);

        const finalSubcategory = childSubcategory || subcategory;
        if (finalSubcategory) product.subcategory = finalSubcategory;

        if (specifications) product.specifications = JSON.parse(specifications);
        await product.save();
        res.json(product);
    } catch (err) {
        console.error('Update product error:', err.message); 
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
        if (product.uploadedVideo && product.uploadedVideo.publicId) {
            await cloudinary.uploader.destroy(product.uploadedVideo.publicId, { resource_type: 'video' });
        }
        
        await product.deleteOne();
        res.json({ message: 'Product deleted successfully' });
    } catch (err) {
        console.error('Delete product error:', err.message); 
        res.status(500).json({ message: 'Error deleting product' });
    }
});



// --------- Admin Routes ----------

// ### ROUTE 2: FIX APPLIED HERE ###
app.get('/api/admin/products', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const products = await Product.find({})
            .populate('seller', 'name email')
             // <<< FIX: Added 'type', 'slug', 'isActive' so frontend model doesn't crash
            .populate('category', 'name slug type isActive')
            .populate('subcategory', 'name');
        res.json(products);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching all products', error: err.message });
    }
});


app.put('/api/admin/products/:id', protect, authorizeRole('admin'), productUpload, async (req, res) => {
    try {
        const { name, description, brand, originalPrice, price, stock, category, subcategory, childSubcategory, specifications, imagesToDelete, unit, isTrending, serviceDurationMinutes, returnPolicy } = req.body;
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found' });

        const parsedPrice = price ? parseFloat(price) : product.price;
        const parsedOriginalPrice = originalPrice ? parseFloat(originalPrice) : product.originalPrice;
        if (parsedOriginalPrice && parsedOriginalPrice < parsedPrice) {
            return res.status(400).json({ message: 'Original price cannot be less than the discounted price.' });
        }

        if (imagesToDelete) {
            const idsToDelete = Array.isArray(imagesToDelete) ? imagesToDelete : [imagesToDelete];
            await Promise.all(idsToDelete.map(publicId => cloudinary.uploader.destroy(publicId)));
            product.images = product.images.filter(img => !idsToDelete.includes(img.publicId));
        }
        
        if (req.files.images && req.files.images.length > 0) {
            const newImages = req.files.images.map(file => ({ url: file.path, publicId: file.filename }));
            product.images.push(...newImages);
        }
        
        if (req.files.video && req.files.video.length > 0) {
            const newVideoFile = req.files.video[0];
            if (product.uploadedVideo && product.uploadedVideo.publicId) {
                await cloudinary.uploader.destroy(product.uploadedVideo.publicId, { resource_type: 'video' });
            }
            product.uploadedVideo = {
                url: newVideoFile.path,
                publicId: newVideoFile.filename
            };
        }
        
        if (name) product.name = name;
        if (description) product.description = description;
        if (brand) product.brand = brand;
        if (originalPrice) product.originalPrice = parsedOriginalPrice;
        if (price) product.price = parsedPrice;
        if (stock) product.stock = stock;
        if (unit) product.unit = unit;
        if (category) product.category = category;
        if (returnPolicy) product.otherInformation.returnPolicy = returnPolicy;
        if (serviceDurationMinutes) product.serviceDurationMinutes = parseInt(serviceDurationMinutes);
        if (typeof isTrending !== 'undefined') product.isTrending = isTrending;

        const finalSubcategory = childSubcategory || subcategory;
        if (finalSubcategory) product.subcategory = finalSubcategory;
        if (specifications) product.specifications = JSON.parse(specifications);
        
        await product.save();
        res.json(product);
    } catch (err) {
        console.error('Admin update product error:', err.message); 
        res.status(500).json({ message: 'Error updating product', error: err.message });
    }
});


// ... (Admin User/Seller/Order Management) ...
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
        if (typeof approved !== 'undefined') {
            if(user.role === 'seller' && approved === true && user.approved === false) {
                await sendWhatsApp(user.phone, "Congratulations! Your seller account has been approved. You can now log in and start selling.");
            }
            user.approved = approved;
        }
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
            .populate('orderItems.product', 'name images price unit')
            .sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching all orders' });
    }
});

app.put('/api/admin/orders/:id/status', protect, authorizeRole('admin', 'seller'), async (req, res) => {
    try {
        const { status } = req.body;
        const order = await Order.findById(req.params.id).populate('user');
        if (!order) return res.status(404).json({ message: 'Order not found' });
        if (req.user.role === 'seller' && order.seller.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Access denied' });
        }
        order.deliveryStatus = status;
        order.history.push({ status: status });
        await order.save();
        
        const orderIdShort = order._id.toString().slice(-6);
        const userMessage = `Order Update: Your order #${orderIdShort} has been updated to: ${status}.`;
        await sendWhatsApp(order.user.phone, userMessage);

        res.json(order);
    } catch (err) {
        res.status(500).json({ message: 'Error updating order status', error: err.message });
    }
});

app.post('/api/admin/broadcast', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { message, target } = req.body; 
        if (!message || !target) {
            return res.status(400).json({ message: 'Message and target audience are required.' });
        }

        let query = {};
        if (target === 'users') {
            query = { role: 'user' };
        } else if (target === 'sellers') {
            query = { role: 'seller', approved: true };
        } else if (target !== 'all') {
            return res.status(400).json({ message: "Invalid target. Must be 'users', 'sellers', or 'all'." });
        }

        const recipients = await User.find(query).select('phone');
        let successCount = 0;
        
        for (const recipient of recipients) {
            if (recipient.phone) {
                await sendWhatsApp(recipient.phone, message);
                successCount++;
            }
        }
        
        res.json({ message: `Broadcast sent successfully to ${successCount} recipients.` });

    } catch (err) {
        console.error('Broadcast error:', err.message); 
        res.status(500).json({ message: 'Error sending broadcast message', error: err.message });
    }
});


// --------- Banner & Splash Routes ----------
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
        console.error('Create banner error:', err.message); 
        res.status(500).json({ message: 'Error creating banner', error: err.message });
    }
});

app.get('/api/banners/hero', async (req, res) => {
    try {
        const banners = await Banner.find({ isActive: true, position: 'top' }).sort({ createdAt: -1 });
        res.json(banners);
    } catch (err) {
        console.error('Error fetching hero banners:', err.message); 
        res.status(500).json({ message: 'Error fetching hero banners' });
    }
});

app.get('/api/banners/dynamic', async (req, res) => {
    try {
        const banners = await Banner.find({ isActive: true, position: { $in: ['middle', 'bottom'] } }).sort({ createdAt: -1 });
        res.json(banners);
    } catch (err) {
        console.error('Error fetching dynamic banners:', err.message); 
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
        console.error('Update banner error:', err.message); 
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
        console.error('Delete banner error:', err.message); 
        res.status(500).json({ message: 'Error deleting banner', error: err.message });
    }
});

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
        
        if (file.mimetype.startsWith('video')) {
            splashData.video = { url: file.path, publicId: file.filename };
        } else {
            splashData.image = { url: file.path, publicId: file.filename };
        }

        const newSplash = await Splash.create(splashData);
        res.status(201).json(newSplash);
    } catch (err) {
        console.error('Create splash error:', err.message); 
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
        console.error('Update splash error:', err.message); 
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
        console.error('Delete splash error:', err.message); 
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
        console.error('Error fetching splash screens:', err.message); 
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

app.get('/api/admin/reports/financial-summary', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const salesSummary = await Order.aggregate([
            { $match: { paymentStatus: 'completed', deliveryStatus: { $ne: 'Cancelled' } } },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: '$totalAmount' },
                    totalRefunds: { $sum: '$totalRefunded' },
                    totalOrders: { $sum: 1 }
                }
            }
        ]);

        const summary = salesSummary.length > 0 ? salesSummary[0] : { totalSales: 0, totalRefunds: 0, totalOrders: 0 };
        const netIncome = summary.totalSales - summary.totalRefunds;

        res.json({
            totalSales: summary.totalSales,
            totalRefunds: summary.totalRefunds,
            totalOrders: summary.totalOrders,
            netIncome: netIncome
        });

    } catch (err) {
        console.error('Error generating financial summary:', err.message);
        res.status(500).json({ message: 'Error generating financial summary report', error: err.message });
    }
});

// ##################################################################
// ## NEW: ADMIN DASHBOARD STATISTICS ENDPOINT (Modified)
// ##################################################################
app.get('/api/admin/statistics/dashboard', protect, authorizeRole('admin'), async (req, res) => {
    try {
        // <<< MODIFIED: Added paymentCounts to the Promise.all
        const [orderStatusCounts, topSellingProducts, topSellingSellers, topCustomers, financialSummaryData, paymentCounts] = await Promise.all([
            
            // 1. Order Status Counts
            Order.aggregate([
                { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } }
            ]),
            
            // 2. Top 5 Products
            Order.aggregate([
                { $match: { deliveryStatus: 'Delivered' } },
                { $unwind: "$orderItems" },
                { $group: { 
                    _id: "$orderItems.product", 
                    totalQuantitySold: { $sum: "$orderItems.qty" }
                }},
                { $sort: { totalQuantitySold: -1 } },
                { $limit: 5 },
                { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'productInfo' } },
                { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } }, 
                { $project: { name: { $ifNull: [ "$productInfo.name", "Deleted Product" ] }, totalQuantitySold: 1 } }
            ]),

            // 3. Top 5 Sellers (by revenue)
            Order.aggregate([
                { $match: { deliveryStatus: 'Delivered' } },
                { $group: {
                    _id: "$seller",
                    totalRevenue: { $sum: "$totalAmount" }
                }},
                { $sort: { totalRevenue: -1 } },
                { $limit: 5 },
                { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'sellerInfo' } },
                { $unwind: { path: "$sellerInfo", preserveNullAndEmptyArrays: true } }, 
                { $project: { name: { $ifNull: [ "$sellerInfo.name", "Deleted Seller" ] }, totalRevenue: 1 } }
            ]),

            // 4. Top 5 Customers (by revenue)
            Order.aggregate([
                { $match: { deliveryStatus: 'Delivered' } },
                { $group: {
                    _id: "$user",
                    totalSpent: { $sum: "$totalAmount" }
                }},
                { $sort: { totalSpent: -1 } },
                { $limit: 5 },
                { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
                { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } }, 
                { $project: { name: { $ifNull: [ "$userInfo.name", "Deleted User" ] }, totalSpent: 1 } }
            ]),
            
            // 5. Financial Summary
            Order.aggregate([
                { $match: { paymentStatus: 'completed', deliveryStatus: { $ne: 'Cancelled' } } },
                { $group: {
                    _id: null,
                    totalSales: { $sum: '$totalAmount' },
                    totalRefunds: { $sum: '$totalRefunded' }
                }}
            ]),

            // 6. ### NEW: Payment Method Counts ###
            Order.aggregate([
                { $match: { paymentStatus: 'completed' } }, // Only count completed payments
                { $group: { _id: "$paymentMethod", count: { $sum: 1 } } }
            ])
        ]);

        // Format order stats
        const orderStatsFormatted = {};
        orderStatusCounts.forEach(stat => {
            orderStatsFormatted[stat._id] = stat.count;
        });

        // ### NEW: Format payment stats ###
        const paymentStatsFormatted = {};
        paymentCounts.forEach(stat => {
            paymentStatsFormatted[stat._id] = stat.count;
        });
        
        const financials = financialSummaryData[0] || { totalSales: 0, totalRefunds: 0 };

        // Send the complete dashboard data object
        res.json({
            orderStats: orderStatsFormatted,
            paymentMethodStats: paymentStatsFormatted, // <<< NEWLY ADDED
            topProducts: topSellingProducts,
            topSellers: topSellingSellers,
            topCustomers: topCustomers,
            financials: {
               totalSales: financials.totalSales,
               totalRefunds: financials.totalRefunds,
               netIncome: financials.totalSales - financials.totalRefunds
            }
        });

    } catch (err) {
        console.error('Error generating dashboard statistics:', err.message);
        res.status(500).json({ message: 'Error fetching dashboard statistics', error: err.message });
    }
});


// ##################################################################
// ## GLOBAL ERROR HANDLER
// ##################################################################
app.use((err, req, res, next) => {
    console.error('🆘 UNHANDLED ERROR 🆘:', err.message);
    console.error(err.stack); 

    if (err instanceof multer.MulterError) {
        return res.status(400).json({ message: 'File upload error', error: err.message });
    }

    if (err.http_code) {
        return res.status(err.http_code).json({ message: 'Cloud storage error', error: err.message });
    }

    res.status(5.00).json({
        message: 'An unexpected server error occurred',
        error: err.message || 'Unknown error'
    });
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
