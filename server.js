// server.js - Full E-Commerce Backend (Patched with all new features)

// Load environment variables from .env file
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

// --- NEW LIBRARIES ---
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = require('./serviceAccountKey.json'); // Assumes key is in root

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// --- Setup Firebase Admin ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

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
      await seedDatabaseData();
    } catch (err) {
      console.error('Error during database seeding:', err.message);
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

// --- [UPDATED CODE SECTION 1] (Feature Update) ---
async function sendPushNotification(tokens, title, body, data = {}, imageUrl = null) {
  try {
    if (!tokens) return;

    const validTokens = (Array.isArray(tokens) ? tokens : [tokens])
      .filter(t => typeof t === 'string' && t.length > 0);

    if (validTokens.length === 0) {
      console.log('Push Notification: No valid FCM tokens to send to.');
      return;
    }
    
    // Base notification payload
    const notificationPayload = { title, body };
    if (imageUrl) {
      notificationPayload.imageUrl = imageUrl;
    }

    // Android-specific payload
    const androidNotificationPayload = {
      sound: 'default',
      clickAction: 'FLUTTER_NOTIFICATION_CLICK',
    };
    if (imageUrl) {
      androidNotificationPayload.imageUrl = imageUrl;
    }

    // APNs (iOS)-specific payload
    const apnsPayload = {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
          // Tells iOS to allow modification for image download
          ...(imageUrl && { 'mutable-content': 1 })
        }
      },
      // FCM bridge for iOS images
      ...(imageUrl && { 
        fcm_options: { 
          image: imageUrl 
        }
      })
    };
    
    const message = {
      notification: notificationPayload,
      data: data,
      tokens: validTokens,
      android: {
        notification: androidNotificationPayload
      },
      apns: apnsPayload
    };

    const response = await getMessaging().sendEachForMulticast(message);
    console.log(`Push Notification: Sent to ${response.successCount} users.`);
    
    if (response.failureCount > 0) {
      console.error(`Push Notification: Failed to send to ${response.failureCount} users.`);
    }

  } catch (err) {
    console.error('Push Notification Failed:', err.message);
  }
}
// --- [END UPDATED CODE SECTION 1] ---


/**
 * HELPER FUNCTION
 * Generates a unique SKU based on category, product name, and random characters.
 */
function generateUniqueSku(categoryId, productName) {
  const catPart = categoryId.toString().slice(-4).toUpperCase();
  let prodPart = productName.substring(0, 3).toUpperCase();
  prodPart = prodPart.replace(/[^A-Z0-9]/g, 'X');

  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();

  return `${catPart}-${prodPart}-${randomPart}`;
}


// --------- Models ----------
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true, index: true },
  password: { type: String, required: true },
  phone: { type: String, unique: true, sparse: true, index: true },
  role: { type: String, enum: ['user', 'seller', 'admin'], default: 'user', index: true },
  pincodes: { type: [String], default: [] },
  approved: { type: Boolean, default: true, index: true },
  passwordResetOTP: String,
  passwordResetOTPExpire: Date,

  pickupAddress: {
    street: String,
    village: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
    isSet: { type: Boolean, default: false }
  },
  
  fcmToken: { type: String, default: null }

}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const appSettingsSchema = new mongoose.Schema({
  singleton: { type: Boolean, default: true, unique: true, index: true },
  platformCommissionRate: { type: Number, default: 0.05, min: 0, max: 1 },
});
const AppSettings = mongoose.model('AppSettings', appSettingsSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  type: { type: String, enum: ['product', 'service'], default: 'product', index: true },
  isActive: { type: Boolean, default: true, index: true },
  image: {
    url: String,
    publicId: String
  },
  sortOrder: { type: Number, default: 0, index: true }
}, { timestamps: true });
const Category = mongoose.model('Category', categorySchema);

const subcategorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null, index: true },
  isTopLevel: { type: Boolean, default: false, index: true },
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
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null, index: true },
  childCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
  originalPrice: Number,
  price: Number,
  costPrice: { type: Number, required: false },
  stock: { type: Number, default: 10 },
  unit: {
    type: String,
    enum: ['kg', '100g', '250g', '500g', 'L', 'ml', 'pcs', 'pack', 'piece', 'bunch', 'packet', 'dozen', 'bag', '50g'],
    required: false,
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
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  isTrending: { type: Boolean, default: false, index: true }
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
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  orderItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    qty: Number,
    originalPrice: Number,
    price: Number,
    category: String
  }],
  shippingAddress: { type: String, required: true },
  deliveryStatus: { type: String, enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'], default: 'Pending', index: true },
  paymentMethod: { type: String, enum: ['cod', 'razorpay'], required: true, index: true },
  paymentId: String,
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending', index: true },
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
  village: { type: String },
  landmark: { type: String },
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

const timeSlotSchema = new mongoose.Schema({
  start: { type: String, required: true },
  end: { type: String, required: true },
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
    monday: dailyAvailabilitySchema,
    tuesday: dailyAvailabilitySchema,
    wednesday: dailyAvailabilitySchema,
    thursday: dailyAvailabilitySchema,
    friday: dailyAvailabilitySchema,
    saturday: dailyAvailabilitySchema,
  },
  customDates: [customDateAvailabilitySchema]
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

const payoutSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
  transactionId: String,
  processedAt: Date,
  notes: String
}, { timestamps: true });
const Payout = mongoose.model('Payout', payoutSchema);

// --- [UPDATED CODE SECTION 2] (Feature Update + Optimization Fix) ---
// --- NEW MODEL: Notification Schema for Scheduled Messages ---
const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  imageUrl: { type: String, default: null }, // <-- ADDED THIS LINE
  target: { type: String, enum: ['all', 'users', 'sellers'], required: true },
  scheduledAt: { type: Date, required: true },
  isSent: { type: Boolean, default: false },
  sentAt: Date,
}, { timestamps: true });

// --- ADDED THIS LINE (Optimization Fix) ---
notificationSchema.index({ isSent: 1, scheduledAt: 1 });
// --- END ---

const ScheduledNotification = mongoose.model('ScheduledNotification', notificationSchema);
// --- [END UPDATED CODE SECTION 2] ---


// --- Database Seeding Function ---
async function seedDatabaseData() {
  try {
    const settingsCount = await AppSettings.countDocuments();
    if (settingsCount === 0) {
      console.log('Creating default app settings...');
      await AppSettings.create({ singleton: true, platformCommissionRate: 0.05 });
      console.log('Default app settings created (5% commission).');
    }

    const categoryCount = await Category.countDocuments();
    if (categoryCount === 0) {
      console.log('No categories found. Creating default categories...');
      const defaultCategories = [
        { name: 'Fruits', slug: 'fruits', type: 'product', sortOrder: 1 },
        { name: 'Vegetables', slug: 'vegetables', type: 'product', sortOrder: 2 },
        { name: 'Clothing', slug: 'clothing', type: 'product', sortOrder: 3 },
        { name: 'Home Services', slug: 'home-services', type: 'service', sortOrder: 10 },
        { name: 'Transport', slug: 'transport', type: 'service', sortOrder: 11 },
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
    console.error('Error creating default data:', err.message);
  }
}


// --------- Middleware ----------
const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      console.error('❌ Authentication Failed: No token provided.');
      return res.status(401).json({ message: 'No token' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      console.error('❌ Authentication Failed: User not found with token.');
      return res.status(401).json({ message: 'Invalid token' });
    }
    next();
  } catch (err) {
    console.error('❌ Authentication Failed: JWT verification error.', err.message);
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
    const categories = await Category.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .select('name slug isActive image type sortOrder');
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
    const categories = await Category.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .select('name slug isActive image type sortOrder');
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching categories', error: err.message });
  }
});

app.post('/api/admin/categories', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
  try {
    const { name, type, sortOrder } = req.body;
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    const slug = name.toLowerCase().replace(/[^a-z09]+/g, '-').replace(/^-+|-+$/g, '');
    const category = await Category.create({
      name,
      slug,
      type: type || 'product',
      sortOrder: sortOrder || 0,
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
    const { name, isActive, type, sortOrder } = req.body;
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
    if (typeof sortOrder !== 'undefined') category.sortOrder = sortOrder;

    await category.save();
    res.json(category);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Category with this name already exists' });
    res.status(500).json({ message: 'Error updating category', error: err.message });
  }
});

app.put('/api/admin/categories/reorder', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) {
      return res.status(400).json({ message: 'Invalid data. "order" must be an array.' });
    }

    const bulkOps = order.map(item => ({
      updateOne: {
        filter: { _id: item.id },
        update: { $set: { sortOrder: item.order } }
      }
    }));

    await Category.bulkWrite(bulkOps);

    res.json({ message: 'Categories reordered successfully.' });
  } catch (err) {
    console.error("Category reorder error:", err.message);
    res.status(500).json({ message: 'Error reordering categories', error: err.message });
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

// --- [CORRECTED SECTION - BUG FIX 2] ---
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
    // The invalid 'type:' line that was here is now removed.
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ message: 'Login error' });
  }
});
// --- [END CORRECTED SECTION - BUG FIX 2] ---

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
    const { name, phone, pincodes, pickupAddress } = req.body;
    const user = await User.findById(req.user._id);
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (pincodes && pincodes.length) user.pincodes = pincodes;

    if (user.role === 'seller' && pickupAddress) {
      user.pickupAddress = {
        street: pickupAddress.street,
        village: pickupAddress.village,
        landmark: pickupAddress.landmark,
        city: pickupAddress.city,
        state: pickupAddress.state,
        pincode: pickupAddress.pincode,
        isSet: !!(pickupAddress.street && pickupAddress.city && pickupAddress.pincode)
      };
    }

    await user.save();
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Error updating profile' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

app.post('/api/auth/save-fcm-token', protect, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'FCM token is required.' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    
    user.fcmToken = token;
    await user.save();

    if (user.role !== 'admin') {
      await sendPushNotification(
        token,
        'Login Successful! ✅',
        `Welcome back, ${user.name}! Your push notifications are now enabled.`,
        { type: 'LOGIN_WELCOME' }
      );
    }
    res.json({ message: 'FCM token saved and welcome notification handled.' });
  } catch (err) {
    console.error('Save FCM Token Error:', err.message);
    res.status(500).json({ message: 'Error saving FCM token', error: err.message });
  }
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
    if (!cart) return res.status(44).json({ message: 'Cart not found' });

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
        select: 'pincodes name phone fcmToken'
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
          totalAmount: 0
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

    const totalCartAmount = Array.from(ordersBySeller.values()).reduce((sum, order) => sum + order.totalAmount, 0);

    if (couponCode) {
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
      }
    }
    
    finalAmountForPayment = Math.max(0, totalCartAmount - discountAmount);

    if (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) {
      paymentMethod = 'cod';
    }

    let razorpayOrder = null;
    if (paymentMethod === 'razorpay') {
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(finalAmountForPayment * 100),
        currency: 'INR',
        receipt: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
      });
    }

    let fullAddress = `${shippingAddress.street}`;
    if (shippingAddress.landmark) fullAddress += `, ${shippingAddress.landmark}`;
    if (shippingAddress.village) fullAddress += `, ${shippingAddress.village}`;
    fullAddress += `, ${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}`;
    const createdOrders = [];
    for (const [sellerId, sellerData] of ordersBySeller.entries()) {
      const sellerDiscount = (discountAmount * sellerData.totalAmount) / totalCartAmount || 0;

      const order = new Order({
        user: req.user._id,
        seller: sellerData.seller,
        orderItems: sellerData.orderItems,
        shippingAddress: fullAddress,
        pincode: shippingAddress.pincode,
        paymentMethod,
        totalAmount: sellerData.totalAmount,
        couponApplied: couponCode,
        discountAmount: sellerDiscount,
        paymentId: razorpayOrder ? razorpayOrder.id : (paymentMethod === 'cod' ? `cod_${crypto.randomBytes(8).toString('hex')}` : undefined),
        paymentStatus: paymentMethod === 'cod' ? 'completed' : 'pending',
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

      const sellerUser = await User.findById(sellerData.seller._id).select('fcmToken');
      if (sellerUser && sellerUser.fcmToken) {
        await sendPushNotification(
          sellerUser.fcmToken,
          '🎉 New Order Received!',
          `You have a new order (#${orderIdShort}) from ${req.user.name}. Total: ₹${order.totalAmount.toFixed(2)}`,
          { orderId: order._id.toString(), type: 'NEW_ORDER' }
        );
      }
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
      user: { name: req.user.name, email: req.user.email, phone: req.user.phone },
      paymentMethod: paymentMethod
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
    
    let refundMessage = '';
    if (order.paymentMethod === 'razorpay' && order.paymentStatus === 'completed') {
      try {
        const refundableAmount = order.totalAmount - order.discountAmount - order.totalRefunded;
        if (refundableAmount > 0) {
          const refund = await razorpay.payments.refund(order.paymentId, {
            amount: Math.round(refundableAmount * 100),
            speed: 'normal',
            notes: { reason: 'Order cancelled by user.' }
          });

          const newRefundEntry = {
            amount: refund.amount / 100,
            reason: 'Order cancelled by user.',
            status: refund.status === 'processed' ? 'completed' : 'processing',
            razorpayRefundId: refund.id,
            processedBy: req.user._id,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          order.refunds.push(newRefundEntry);
          order.totalRefunded += newRefundEntry.amount;
          order.paymentStatus = 'refunded';
          refundMessage = ' Your payment is being refunded.';
        }
      } catch (refundErr) {
        console.error("Auto-refund on cancel failed:", refundErr.message);
        refundMessage = ' We will process your refund manually shortly.';
        await notifyAdmin(`Admin Alert: Auto-refund FAILED for cancelled order #${order._id}. Please process manually.`);
      }
    }
    
    await order.save();

    for(const item of order.orderItems) {
      await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
    }

    const orderIdShort = order._id.toString().slice(-6);
    const sellerMessage = `Order Cancellation: Order #${orderIdShort} has been cancelled by the customer.`;
    await sendWhatsApp(order.seller.phone, sellerMessage);
    await notifyAdmin(`Admin Alert: Order #${orderIdShort} cancelled by user.`);

    res.json({ message: `Order cancelled successfully.${refundMessage}`, order });
  } catch (err) {
    res.status(500).json({ message: 'Error cancelling order' });
  }
});


// --------- BOOKING & AVAILABILITY ROUTES ----------
app.get('/api/seller/availability', protect, authorizeRole('seller', 'admin'), async (req, res) => {
  try {
    let availability = await Availability.findOne({ provider: req.user._id });

    if (!availability) {
      const defaultDay = { isActive: false, slots: [{ start: "09:00", end: "17:00" }] };
      availability = await Availability.create({
        provider: req.user._id,
        days: {
          monday:       defaultDay,
          tuesday:      defaultDay,
          wednesday: defaultDay,
          thursday:     defaultDay,
          friday:       defaultDay,
          saturday:     defaultDay,
          sunday:       defaultDay,
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

    const service = await Product.findById(req.params.id).populate('category');
    if (!service || !service.seller) {
      return res.status(404).json({ message: 'Service or service provider not found.' });
    }

    if (service.category.type !== 'service' || !service.serviceDurationMinutes) {
      return res.status(400).json({ message: 'This product is not a bookable service.' });
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

    const service = await Product.findById(serviceId).populate('seller').populate('category');
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
    });

    const providerPhone = service.seller.phone;
    const formattedDate = bookingStart.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
    const message = `🎉 New Booking Request!\n\nService: ${service.name}\nUser: ${req.user.name}\nSlot: ${formattedDate}.\nPlease log in to your panel to accept or reject.`;
    await sendWhatsApp(providerPhone, message);

    const providerUser = await User.findById(providerId).select('fcmToken');
    if (providerUser && providerUser.fcmToken) {
      await sendPushNotification(
        providerUser.fcmToken,
        '🎉 New Booking Request!',
        `Service: ${service.name} from ${req.user.name}. Slot: ${formattedDate}.`,
        { bookingId: newBooking._id.toString(), type: 'NEW_BOOKING' }
      );
    }
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

    const user = await User.findById(booking.user._id).select('fcmToken');
    if (user && user.fcmToken) {
      await sendPushNotification(
        user.fcmToken,
        'Booking Status Updated',
        `Your booking for "${booking.service.name}" on ${formattedDate} has been ${status}.`,
        { bookingId: booking._id.toString(), type: 'BOOKING_STATUS' }
      );
    }
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
      const orders = await Order.find({ paymentId: order_id });
      if (orders && orders.length > 0) {
        
        const paymentHistoryEntries = [];

        for (const order of orders) {
          order.paymentStatus = 'completed';
          order.paymentId = payment_id;
          await order.save();

          paymentHistoryEntries.push({
            user: order.user,
            order: order._id,
            razorpayOrderId: order_id,
            razorpayPaymentId: payment_id,
            amount: order.totalAmount,
            status: 'completed',
          });
        }
        
        await PaymentHistory.insertMany(paymentHistoryEntries);

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
    const { name, street, village, landmark, city, state, pincode, phone, isDefault = false } = req.body;
    const newAddress = await Address.create({
      user: req.user._id,
      name, street, village, landmark, city, state, pincode, phone, isDefault
    });
    res.status(201).json(newAddress);
  } catch (err) {
    res.status(500).json({ message: 'Error adding address' });
  }
});

app.put('/api/addresses/:id', protect, async (req, res) => {
  try {
    const { name, street, village, landmark, city, state, pincode, phone, isDefault } = req.body;
    const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
    if (!address) return res.status(404).json({ message: 'Address not found or you do not have permission' });

    if (name) address.name = name;
    if (street) address.street = street;
    if (village) address.village = village;
    if (landmark) address.landmark = landmark;
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

app.delete('/api/addresses/:id', protect, authorizeRole('admin'), async (req, res) => {
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
        subcategories: await getNestedSubcategories(child._id),
      })));
    };

    const categories = await Category.find({}).sort({ sortOrder: 1, name: 1 });

    const responseData = await Promise.all(categories.map(async (category) => {
      const subcategories = await Subcategory.find({ category: category._id, isTopLevel: true }).sort({ name: 1 });
      
      const nestedSubcategories = await Promise.all(subcategories.map(async (sub) => ({
        id: sub._id,
        name: sub.name,
        subcategories: await getNestedSubcategories(sub._id),
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

app.get('/api/seller/products', protect, authorizeRole('seller', 'admin'), async (req, res) => {
  try {
    const products = await Product.find({ seller: req.user._id })
      .populate('seller', 'name email phone pincodes')
      .populate('subcategory', 'name image')
      .populate('category', 'name slug type isActive image');
    res.json(products);
  } catch (error) {
    console.error("Seller products error:", error.message);
    res.status(500).json({ message: 'Error fetching seller products' });
  }
});

app.get('/api/seller/financials', protect, authorizeRole('seller'), async (req, res) => {
  try {
    const sellerId = req.user._id;

    const appSettings = await AppSettings.findOne({ singleton: true });
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;

    const totalRevenueResult = await Order.aggregate([
      { $match: { seller: sellerId, deliveryStatus: 'Delivered', paymentStatus: 'completed' } },
      { $group: { _id: null, totalSales: { $sum: "$totalAmount" } } }
    ]);
    const totalRevenue = totalRevenueResult[0]?.totalSales || 0;

    const platformCommission = totalRevenue * PLATFORM_COMMISSION_RATE;
    const netEarnings = totalRevenue - platformCommission;

    const totalPayoutsResult = await Payout.aggregate([
      { $match: { seller: sellerId, status: 'processed' } },
      { $group: { _id: null, totalProcessed: { $sum: "$amount" } } }
    ]);
    const totalPayouts = totalPayoutsResult[0]?.totalProcessed || 0;

    const currentBalance = netEarnings - totalPayouts;

    const payouts = await Payout.find({ seller: sellerId }).sort({ createdAt: -1 });

    res.json({
      totalRevenue: totalRevenue,
      netEarnings: netEarnings,
      platformCommission: platformCommission,
      totalPayouts: totalPayouts,
      currentBalance: currentBalance,
      payouts: payouts,
      commissionRate: PLATFORM_COMMISSION_RATE
    });

  } catch (err) {
    console.error('Error fetching seller financials:', err.message);
    res.status(500).json({ message: 'Error fetching financial data', error: err.message });
  }
});


app.post('/api/seller/products', protect, authorizeRole('seller', 'admin'), checkSellerApproved, productUpload, async (req, res) => {
  try {
    const {
      productTitle, brand, category, subcategory, childCategory,
      mrp, sellingPrice, costPrice, stockQuantity, unit, minOrderQty,
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
      costPrice: costPrice ? parseFloat(costPrice) : undefined,
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
    const { name, description, brand, originalPrice, price, stock, category, subcategory, childSubcategory, specifications, imagesToDelete, unit, serviceDurationMinutes, returnPolicy, costPrice, isTrending } = req.body;
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
    if (originalPrice) product.originalPrice = parsedOriginalPrice;
    if (price) product.price = parsedPrice;
    if (costPrice) product.costPrice = parseFloat(costPrice);
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

// --- [CORRECTED SECTION - BUG FIX 3] ---
app.get('/api/seller/orders/:id/shipping-label', protect, authorizeRole('seller'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('user', 'name phone');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this order' });
    }

    const sellerAddress = req.user.pickupAddress;
    if (!sellerAddress || !sellerAddress.isSet || !sellerAddress.pincode) {
      return res.status(400).json({ message: 'Seller pickup address is not set in your profile. Please update it first.' });
    }

    const customerAddressString = order.shippingAddress;
    const customerName = order.user.name;
    const customerPhone = order.user.phone;
    const orderId = order._id.toString();

    const barcodePng = await bwipjs.toBuffer({
      bcid: 'code128',
      text: orderId,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: 'center',
    });

    const doc = new PDFDocument({
      size: [288, 432],
      margins: { top: 20, bottom: 20, left: 20, right: 20 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="label-${orderId}.pdf"`);

    doc.pipe(res);

    doc.fontSize(14).font('Helvetica-Bold').text(`Order: #${orderId.slice(-8)}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Payment: ${order.paymentMethod.toUpperCase()}`, { align: 'center' });

    if (order.paymentMethod === 'cod') {
      const finalAmount = order.totalAmount - order.discountAmount;
      doc.fontSize(12).font('Helvetica-Bold').text(`Amount Due: ₹${finalAmount.toFixed(2)}`, { align: 'center' });
    }
    doc.moveDown(1);

    doc.fontSize(10).font('Helvetica-Bold').text('SHIP FROM:');
    doc.fontSize(10).font('Helvetica').text(req.user.name);
    doc.text(sellerAddress.street);
    if (sellerAddress.landmark) doc.text(`Landmark: ${sellerAddress.landmark}`);
    if (sellerAddress.village) doc.text(`Village: ${sellerAddress.village}`);
    doc.text(`${sellerAddress.city}, ${sellerAddress.state} - ${sellerAddress.pincode}`);
    doc.text(`Phone: ${req.user.phone}`);

    doc.moveDown(2);

    doc.rect(15, 170, 258, 120).stroke();
    doc.fontSize(12).font('Helvetica-Bold').text('SHIP TO:', 20, 175);
    doc.fontSize(14).font('Helvetica-Bold').text(customerName, 20, 195);
    // The stray '.' that was on the next line has been removed.
    doc.fontSize(12).font('Helvetica').text(`Phone: ${customerPhone}`, 20, 215);
    doc.text(customerAddressString, 20, 235, { width: 248 });

    doc.moveDown(6);

    doc.image(barcodePng, {
      fit: [250, 70],
      align: 'center',
      valign: 'bottom'
    });

    doc.end();

  } catch (err) {
    console.error('Failed to generate shipping label:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error generating PDF label', error: err.message });
    }
  }
});
// --- [END CORRECTED SECTION - BUG FIX 3] ---


// --------- Admin Routes ----------
app.get('/api/admin/products', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const products = await Product.find({})
      .populate('seller', 'name email')
      .populate('category', 'name slug type isActive')
      .populate('subcategory', 'name');
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching all products', error: err.message });
  }
});


app.put('/api/admin/products/:id', protect, authorizeRole('admin'), productUpload, async (req, res) => {
  try {
    const { name, description, brand, originalPrice, price, stock, category, subcategory, childSubcategory, specifications, imagesToDelete, unit, isTrending, serviceDurationMinutes, returnPolicy, costPrice } = req.body;
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
    if (originalPrice) product.originalPrice = parsedOriginalPrice;
    if (price) product.price = parsedPrice;
    if (costPrice) product.costPrice = parseFloat(costPrice);
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
        const msg = "Congratulations! Your seller account has been approved. You can now log in and start selling.";
        await sendWhatsApp(user.phone, msg);
        
        if (user.fcmToken) {
          await sendPushNotification(
            user.fcmToken,
            'Account Approved!',
            'Congratulations! Your seller account has been approved. You can now log in and start selling.',
            { type: 'ACCOUNT_APPROVED' }
          );
        }
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

    const user = await User.findById(order.user._id).select('fcmToken');
    if (user && user.fcmToken) {
      await sendPushNotification(
        user.fcmToken,
        'Order Status Updated',
        `Your order #${orderIdShort} is now: ${status}.`,
        { orderId: order._id.toString(), type: 'ORDER_STATUS' }
      );
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Error updating order status', error: err.message });
  }
});


// --- [UPDATED CODE SECTION 3] (Feature Update) ---
app.post('/api/admin/broadcast', protect, authorizeRole('admin'), async (req, res) => {
  try {
    // Add 'title' and 'imageUrl' to destructuring
    const { title, message, target, imageUrl } = req.body; 
    
    // Add 'title' to validation
    if (!title || !message || !target) { 
      return res.status(400).json({ message: 'Title, message, and target audience are required.' });
    }

    let query = {};
    if (target === 'users') {
      query = { role: 'user' };
    } else if (target === 'sellers') {
      query = { role: 'seller', approved: true };
    } else if (target !== 'all') {
      return res.status(400).json({ message: "Invalid target. Must be 'users', 'sellers', or 'all'." });
    }

    const recipients = await User.find(query).select('phone fcmToken');
    
    let successCount = 0;
    const fcmTokens = [];

    for (const recipient of recipients) {
      if (recipient.phone) {
        // Send a more structured WhatsApp message
        await sendWhatsApp(recipient.phone, `*${title}*\n\n${message}`);
        successCount++;
      }
      if (recipient.fcmToken) {
        fcmTokens.push(recipient.fcmToken);
      }
    }

    if (fcmTokens.length > 0) {
      // Pass all new parameters to the updated function
      await sendPushNotification(
        fcmTokens, 
        title, 
        message, 
        { type: 'BROADCAST' },
        imageUrl // Pass the image URL
      );
    }

    res.json({ message: `Broadcast sent successfully to ${successCount} recipients.` });

  } catch (err) {
    console.error('Broadcast error:', err.message);
    res.status(500).json({ message: 'Error sending broadcast message', error: err.message });
  }
});
// --- [END UPDATED CODE SECTION 3] ---


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
      
      const newType = type || (file.mimetype.startsWith('video') ? 'video' : 'image');
      banner.type = newType;
      if (newType === 'image') {
        banner.image = { url: file.path, publicId: file.filename };
        banner.video = { url: null, publicId: null };
      } else {
        banner.video = { url: file.path, publicId: file.filename };
        banner.image = { url: null, publicId: null };
      }

    } else if (type) {
      banner.type = type;
      if (type === 'image' && banner.video.publicId) {
          banner.video = { url: null, publicId: null };
      } else if (type === 'video' && banner.image.publicId) {
          banner.image = { url: null, publicId: null };
      }
    }
    
    if (title) banner.title = title;
    if (link) banner.link = link;
    if (typeof isActive !== 'undefined') banner.isActive = isActive === 'true';
    if (position) banner.position = position;

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


// --------- ADMIN APP SETTINGS ROUTES ----------
app.get('/api/admin/settings', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const settings = await AppSettings.findOne({ singleton: true });
    if (!settings) {
      const newSettings = await AppSettings.create({ singleton: true, platformCommissionRate: 0.05 });
      return res.json(newSettings);
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err.message);
    res.status(500).json({ message: 'Error fetching app settings', error: err.message });
  }
});

app.put('/api/admin/settings', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { platformCommissionRate } = req.body;
    
    const updateData = {};
    if (typeof platformCommissionRate !== 'undefined') {
      const rate = parseFloat(platformCommissionRate);
      if (rate < 0 || rate > 1) {
        return res.status(400).json({ message: 'Commission rate must be between 0 (0%) and 1 (100%).' });
      }
      updateData.platformCommissionRate = rate;
    }

    const updatedSettings = await AppSettings.findOneAndUpdate(
      { singleton: true },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(updatedSettings);
  } catch (err) {
    console.error('Error updating settings:', err.message);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: 'Validation failed', error: err.message });
    }
    res.status(500).json({ message: 'Error updating app settings', error: err.message });
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
      { $unwind: { path: "$productInfo", preserveNullAndEmptyArrays: true } },
      { $project: { name: { $ifNull: [ "$productInfo.name", "Deleted Product" ] }, totalQuantitySold: 1 } }
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
    
    const appSettings = await AppSettings.findOne({ singleton: true });
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;

    const summary = salesSummary.length > 0 ? salesSummary[0] : { totalSales: 0, totalRefunds: 0, totalOrders: 0 };
    
    const platformEarnings = summary.totalSales * PLATFORM_COMMISSION_RATE;
    const netRevenue = summary.totalSales - summary.totalRefunds;

    res.json({
      totalSales: summary.totalSales,
      totalRefunds: summary.totalRefunds,
      totalOrders: summary.totalOrders,
      netRevenue: netRevenue,
      platformEarnings: platformEarnings,
      commissionRate: PLATFORM_COMMISSION_RATE
    });

  } catch (err) {
    console.error('Error generating financial summary:', err.message);
    res.status(500).json({ message: 'Error generating financial summary report', error: err.message });
  }
});

app.get('/api/admin/statistics/dashboard', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const [
      orderStatusCounts,
      topSellingProducts,
      topSellingSellers,
      topCustomers,
      financialSummaryData,
      paymentCounts,
      appSettings
    ] = await Promise.all([

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
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$totalAmount' },
            totalRefunds: { $sum: '$totalRefunded' }
          }
        }
      ]),

      // 6. Payment Method Counts
      Order.aggregate([
        { $match: { paymentStatus: 'completed' } },
        { $group: { _id: "$paymentMethod", count: { $sum: 1 } } }
      ]),

      // 7. Get App Settings
      AppSettings.findOne({ singleton: true })
    ]);

    const orderStatsFormatted = {};
    orderStatusCounts.forEach(stat => {
      orderStatsFormatted[stat._id] = stat.count;
    });

    const paymentStatsFormatted = {};
    paymentCounts.forEach(stat => {
      paymentStatsFormatted[stat._id] = stat.count;
    });

    const financials = financialSummaryData[0] || { totalSales: 0, totalRefunds: 0 };
    
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;
    const platformEarnings = financials.totalSales * PLATFORM_COMMISSION_RATE;
    const netRevenue = financials.totalSales - financials.totalRefunds;

    res.json({
      orderStats: orderStatsFormatted,
      paymentMethodStats: paymentStatsFormatted,
      topProducts: topSellingProducts,
      topSellers: topSellingSellers,
      topCustomers: topCustomers,
      financials: {
        totalSales: financials.totalSales,
        totalRefunds: financials.totalRefunds,
        netRevenue: netRevenue,
        platformEarnings: platformEarnings,
        commissionRate: PLATFORM_COMMISSION_RATE
      }
    });

  } catch (err) {
    console.error('Error generating dashboard statistics:', err.message);
    res.status(500).json({ message: 'Error fetching dashboard statistics', error: err.message });
  }
});

app.post('/api/admin/orders/:id/refund', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const order = await Order.findById(req.params.id).populate('user');

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.paymentMethod !== 'razorpay' || order.paymentStatus !== 'completed') {
      return res.status(400).json({ message: 'Refunds are only available for completed Razorpay payments.' });
    }
    
    const paymentId = order.paymentId;
    if (!paymentId.startsWith('pay_')) {
      return res.status(400).json({ message: 'Invalid payment ID associated with this order. Cannot refund.' });
    }

    const refundableAmount = order.totalAmount - order.discountAmount - order.totalRefunded;
    const requestedAmount = parseFloat(amount);

    if (!requestedAmount || requestedAmount <= 0 || requestedAmount > refundableAmount) {
      return res.status(400).json({ message: `Invalid refund amount. Max refundable amount is ${refundableAmount.toFixed(2)}.` });
    }

    const refund = await razorpay.payments.refund(paymentId, {
      amount: Math.round(requestedAmount * 100),
      speed: 'normal',
      notes: { reason: reason }
    });

    const newRefundEntry = {
      amount: refund.amount / 100,
      reason: reason || 'Not specified',
      status: refund.status === 'processed' ? 'completed' : 'processing',
      razorpayRefundId: refund.id,
      processedBy: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    order.refunds.push(newRefundEntry);
    order.totalRefunded += newRefundEntry.amount;
    order.history.push({ status: 'Refund Initiated', note: `Refund of ${newRefundEntry.amount} initiated by Admin.` });
    
    if (order.totalRefunded >= (order.totalAmount - order.discountAmount)) {
      order.paymentStatus = 'refunded';
    }

    await order.save();

    const user = order.user;
    if (user && user.phone) {
      const message = `💸 Refund Alert!\n\nYour refund of ₹${newRefundEntry.amount} for order #${order._id.toString().slice(-6)} has been initiated. The amount will be credited to your account shortly.`;
      await sendWhatsApp(user.phone, message);

      if (user.fcmToken) {
        await sendPushNotification(
          user.fcmToken,
          '💸 Refund Initiated',
          `Your refund of ₹${newRefundEntry.amount} for order #${order._id.toString().slice(-6)} has been initiated.`,
          { orderId: order._id.toString(), type: 'REFUND' }
        );
      }
    }

    res.status(200).json({
      message: 'Refund initiated successfully.',
      refund,
      order
    });

  } catch (err) {
    console.error('Error initiating refund:', err.message);
    res.status(500).json({
      message: 'Failed to initiate refund.',
      error: err.message
    });
  }
});


// --- [UPDATED CODE SECTION 4] (Feature Update) ---
// --- NEW ROUTES FOR NOTIFICATION SCHEDULING ---
app.post('/api/admin/notifications/schedule', protect, authorizeRole('admin'), async (req, res) => {
  try {
    // Add 'imageUrl'
    const { title, body, target, scheduledAt, imageUrl } = req.body; 
    
    if (!title || !body || !target || !scheduledAt) {
      return res.status(400).json({ message: 'Title, body, target, and scheduledAt are required.' });
    }
    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime()) || scheduledDate < new Date()) {
      return res.status(400).json({ message: 'Invalid or past scheduled date.' });
    }
    
    // Add 'imageUrl' to the create object
    const newNotification = await ScheduledNotification.create({ 
      title, 
      body, 
      target, 
      scheduledAt: scheduledDate,
      imageUrl: imageUrl || null // Add this
    });
    
    res.status(201).json({ message: 'Notification scheduled successfully.', notification: newNotification });
  } catch (err) {
    console.error('Schedule notification error:', err.message);
    res.status(500).json({ message: 'Error scheduling notification.', error: err.message });
  }
});
// --- [END UPDATED CODE SECTION 4] ---


app.get('/api/admin/notifications', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const notifications = await ScheduledNotification.find().sort({ scheduledAt: -1 });
    res.json(notifications);
  } catch (err) {
    console.error('Get notifications error:', err.message);
    res.status(500).json({ message: 'Error fetching notifications.', error: err.message });
  }
});

// --------- GLOBAL ERROR HANDLER ----------
app.use((err, req, res, next) => {
  console.error('🆘 UNHANDLED ERROR 🆘:', err.message);
  console.error(err.stack);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ message: 'File upload error', error: err.message });
  }

  if (err.http_code) {
    return res.status(err.http_code).json({ message: 'Cloud storage error', error: err.message });
  }

  res.status(500).json({
    message: 'An unexpected server error occurred',
    error: err.message || 'Unknown error'
  });
});


// --- [UPDATED CODE SECTION 5] (Feature Update + Bug Fix 1) ---
// --- CRON JOB: Check for scheduled notifications every minute ---
cron.schedule('* * * * *', async () => {
  console.log('Running scheduled notification check...');
  const now = new Date();
  try {
    const notificationsToSend = await ScheduledNotification.find({
      scheduledAt: { $lte: now },
      isSent: false
    });

    for (const notification of notificationsToSend) {
      let query = {};
      if (notification.target === 'users') {
        query = { role: 'user' };
      } else if (notification.target === 'sellers') {
        query = { role: 'seller', approved: true };
      } else if (notification.target !== 'all') {
        continue;
      }

      const recipients = await User.find(query).select('fcmToken');
      const fcmTokens = recipients.map(r => r.fcmToken).filter(Boolean);

      if (fcmTokens.length > 0) {
        // Pass the 'notification.imageUrl' from the DB
        await sendPushNotification(
          fcmTokens, 
          notification.title, 
          notification.body, // <-- This line is now fixed (no nbsp;)
          { type: 'BROADCAST' },
          notification.imageUrl // <-- ADD THIS
        );
      }

      notification.isSent = true;
      notification.sentAt = new Date();
      await notification.save();
      console.log(`Sent scheduled notification: "${notification.title}" to ${fcmTokens.length} recipients.`);
    }

  } catch (err) {
    console.error('Scheduled task failed:', err.message);
  }
});
// --- [END UPDATED CODE SECTION 5] ---


// --------- Other Routes ----------
app.get('/', (req, res) => {
  res.send('E-Commerce Backend API is running!');
});

const IP = '0.0.0.0';
const PORT = process.env.PORT || 5001;

app.listen(PORT, IP, () => {
  console.log(`🚀 Server running on http://${IP}:${PORT}`);
});
