

// server.js - Full E-Commerce Backend (Patched with all new features + Delivery Module + Tax/GST + Razorpay Webhook)

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
const qrcode = require('qrcode');
// --- [END NEW LIBRARY] ---

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

// --- CONSTANTS FOR DYNAMIC DELIVERY AND TAX (UPDATED) ---
const BASE_PINCODE = process.env.BASE_PINCODE || '804425'; // Default Pincode
const LOCAL_DELIVERY_FEE = 20; // UPDATED: Same Pincode delivery cost (₹20)
const REMOTE_DELIVERY_FEE = 40; // UPDATED: Different Pincode delivery cost (₹40)
const GST_RATE = 0.0; // 0% GST for all products
// --- END CONSTANTS ---

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
  { name: 'images', maxCount: 10 },        // Main product gallery
  { name: 'variantImages', maxCount: 20 }, // Individual variant images (matching array index)
  { name: 'video', maxCount: 1 }           // Optional video field
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

async function sendPushNotification(tokens, title, body, data = {}, imageUrl = null) {
  try {
    if (!tokens) return;
    const validTokens = (Array.isArray(tokens) ? tokens : [tokens]).filter(t => typeof t === 'string' && t.length > 0);
    if (validTokens.length === 0) {
      console.log('Push Notification: No valid FCM tokens.');
      return;
    }
    
    const notificationPayload = { title, body };
    // The key must be 'image', not 'imageUrl'
    if (imageUrl) {
      notificationPayload.image = imageUrl;
    }

    const message = {
      notification: notificationPayload,
      data: data,
      tokens: validTokens,
      android: {
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            ...(imageUrl && { 'mutable-content': 1 })
          }
        },
        ...(imageUrl && { 
          fcm_options: { 
            image: imageUrl 
          }
        })
      }
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

/**
 * Calculates shipping fee based on customer's pincode vs. base pincode.
 */
function calculateShippingFee(customerPincode) {
    if (customerPincode === BASE_PINCODE) {
        return LOCAL_DELIVERY_FEE;
    }
    return REMOTE_DELIVERY_FEE;
}


// --------- Models ----------
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, sparse: true, index: true },
    password: { type: String, required: true },
    phone: { type: String, unique: true, sparse: true, index: true },
    role: { type: String, enum: ['user', 'seller', 'admin', 'delivery'], default: 'user', index: true },
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
    
    // ======== ✨ NEW PAYOUT DETAILS FIELD ✨ ========
    payoutDetails: {
        // Razorpay Contact ID (Used to group Fund Accounts for RazorpayX)
        razorpayContactId: { type: String, default: null }, 
        
        // The core ID for automated payouts using RazorpayX APIs
        razorpayFundAccountId: { type: String, default: null, index: true }, 
        
        // To classify the type of account stored
        accountType: { type: String, enum: ['bank', 'vpa', null], default: null },

        // Store plain bank details (useful for display or manual transfer reference)
        bankAccountNumber: { type: String, default: null },
        ifsc: { type: String, default: null },
        vpa: { type: String, default: null } 
    },
    // ===============================================

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
  sku: String, // Main product SKU (optional)
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null, index: true },
  childCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
  
  // ❌ Main price and stock fields are removed from here.
  
  unit: {
    type: String,
    enum: ['kg', '100g', '250g', '500g', 'L', 'ml', 'pcs', 'pack', 'piece', 'bunch', 'packet', 'dozen', 'bag', '50g'],
    required: false,
  },
  minOrderQty: { type: Number, default: 1 },
  shortDescription: String,
  fullDescription: String,
  
  // Main images for the product (can be used as default)
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
  
  // ✅ UPDATED VARIANTS SECTION
  // This is now an array, where each object is a unique variant with its own details.
  variants: [{
      color: { type: String },
      size: { type: String },
      price: { type: Number, required: true },
      originalPrice: { type: Number }, // MRP for this specific variant
      costPrice: { type: Number }, // Cost price for this variant
      stock: { type: Number, required: true, default: 0 },
      sku: { type: String }, // Optional: Unique SKU for this variant
      images: [{ // Optional: Images specific to this variant
        url: String,
        publicId: String
      }]
  }],
  
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
  
  pincodes: [{ 
    type: String, 
    required: false,
    index: true
  }], 
  
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
    category: String,
    // ⭐️ FIX: REMOVING required: true ⭐️
    selectedColor: { type: String, required: false }, // Allow null/undefined for non-variant items
    selectedSize: { type: String, required: false }   // Allow null/undefined for non-variant items

    // --------------------------------------------------
  }],
  shippingAddress: { type: String, required: true },
  deliveryStatus: { 
    type: String, 
    enum: ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled', 'Payment Pending', 'Return Requested'], 
    default: 'Pending', 
    index: true 
  }, 
  paymentMethod: { type: String, enum: ['cod', 'razorpay', 'razorpay_cod'], required: true, index: true },
  paymentId: String,
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending', index: true },
  pincode: String,
  totalAmount: Number, // Items Total (Subtotal)
  taxRate: { type: Number, default: GST_RATE },
  taxAmount: { type: Number, default: 0 },
  couponApplied: String,
  discountAmount: { type: Number, default: 0 },
  shippingFee: { type: Number, default: 0 }, 
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
  history: [{ status: String, timestamp: { type: Date, default: Date.now } }],
  razorpayPaymentLinkId: { type: String, default: null }
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

const cartSchema = new mongoose.Schema({
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    unique: true 
  },
  items: [{
    product: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'Product', 
      required: true 
    },
    qty: { 
      type: Number, 
      required: true, 
      default: 1 
    },
    // ⭐️ FIX: ADDED FIELDS TO STORE SELECTED VARIANTS ⭐️
    selectedColor: { 
      type: String 
    },
    selectedSize: { 
      type: String 
    },
    // ----------------------------------------------------
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

const payoutSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
  transactionId: String,
  processedAt: Date,
  notes: String
}, { timestamps: true });
const Payout = mongoose.model('Payout', payoutSchema);

const deliveryAssignmentSchema = new mongoose.Schema({
  order: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Order', 
    required: true, 
    unique: true
  },
  deliveryBoy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    default: null,
    index: true 
  },
  status: { 
    type: String, 
    enum: ['Pending', 'Accepted', 'PickedUp', 'Delivered', 'Cancelled'], 
    default: 'Pending',
    index: true
  },
  pincode: { 
    type: String, 
    required: true, 
    index: true
  },
  history: [{
    status: String,
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });
const DeliveryAssignment = mongoose.model('DeliveryAssignment', deliveryAssignmentSchema);

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  imageUrl: { type: String, default: null },
  target: { type: String, enum: ['all', 'users', 'sellers', 'delivery_boys'], required: true },
  scheduledAt: { type: Date, required: true },
  isSent: { type: Boolean, default: false },
  sentAt: Date,
}, { timestamps: true });
notificationSchema.index({ isSent: 1, scheduledAt: 1 });
const ScheduledNotification = mongoose.model('ScheduledNotification', notificationSchema);

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
        
      ];
      const createdCategories = await Category.insertMany(defaultCategories);
      console.log('Default categories created:', createdCategories.map(c => c.name));

      const fruitsId = createdCategories.find(c => c.name === 'Fruits')._id;
      const vegetablesId = createdCategories.find(c => c.name === 'Vegetables')._id;

      const defaultSubcategories = [
        { name: 'Mango', category: fruitsId, isTopLevel: true },
     
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


// --------------------------------------------------------------------------------
// --------- AUTH ROUTES (Includes new OTP Registration and existing Firebase/Login) ----------
// --------------------------------------------------------------------------------

// --- NEW OTP REGISTRATION ENDPOINTS ---

// [NEW] 1. Endpoint to send the OTP for registration
app.post('/api/auth/send-otp-register', async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) return res.status(400).json({ message: 'Phone number is required.' });

        // 1. Ensure user does not already exist as a finalized user
        const existingUser = await User.findOne({ phone, role: 'user', approved: true });
        if (existingUser) {
            return res.status(409).json({ message: 'User with this phone number is already registered. Please log in.' });
        }

        // 2. Generate and Hash OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedOTP = await bcrypt.hash(otp, 10);
        const otpExpire = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

        // 3. Find or Create a temporary user record to hold the OTP data
        let tempUser = await User.findOne({ phone });
        
        if (!tempUser) {
            // Create a temporary record (using required fields with dummy data)
            const randomString = crypto.randomBytes(8).toString('hex');
            tempUser = new User({
                name: `TEMP-${phone.slice(-4)}`,
                email: `temp-${phone.substring(1).replace(/\+/g, '')}@otp-reg.com`,
                phone: phone,
                password: await bcrypt.hash(randomString, 10), // Required field
                role: 'user',
                approved: false // Mark as unapproved/pending registration
            });
            await tempUser.save();
        }
        
        tempUser.passwordResetOTP = hashedOTP;
        tempUser.passwordResetOTPExpire = otpExpire;
        await tempUser.save();


        // 4. Send OTP
        console.log(`[REGISTRATION OTP for ${phone}]: ${otp}`);
        const message = `Namaste! Your OTP for registration is ${otp}. This OTP is valid for 10 minutes.`;
        await sendWhatsApp(phone, message); 

        res.status(200).json({ message: 'OTP sent successfully. Proceed to verification.' });

    } catch (err) {
        console.error('Send OTP for registration error:', err.message);
        res.status(500).json({ message: 'Server error sending OTP.' });
    }
});


// [NEW] 2. Endpoint to verify OTP and finalize registration
app.post('/api/auth/register-with-otp', async (req, res) => {
    try {
        const { name, email, phone, pincode, otp } = req.body;
        
        if (!name || !phone || !pincode || !otp) {
            return res.status(400).json({ message: 'Name, phone, pincode, and OTP are required for registration.' });
        }

        // 1. Find the user record with the temporary OTP
        const user = await User.findOne({
            phone,
            passwordResetOTPExpire: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ message: 'Registration failed. OTP expired or phone number not found.' });
        }

        // 2. Verify the OTP
        const isMatch = await bcrypt.compare(otp, user.passwordResetOTP);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid OTP. Please try again.' });
        }

        // 3. Finalize User Creation/Update
        const finalEmail = email || `${phone.substring(1).replace(/\+/g, '')}@user-reg.com`;
        
        // Ensure email uniqueness if provided and if it's different from the temporary one
        if (email && finalEmail !== user.email) {
            const emailCheck = await User.findOne({ email: finalEmail });
            if (emailCheck && emailCheck.phone !== phone) {
                return res.status(409).json({ message: 'This email address is already in use.' });
            }
        }
        
        // Create a real password hash (since the password field is required and we need a secure hash)
        const newPassword = crypto.randomBytes(16).toString('hex');
        const finalPasswordHash = await bcrypt.hash(newPassword, 10);


        user.name = name;
        user.email = finalEmail; 
        user.password = finalPasswordHash;
        user.pincodes = [pincode];
        user.approved = true; 
        user.passwordResetOTP = undefined;
        user.passwordResetOTPExpire = undefined;
        await user.save();


        // 4. Registration successful, generate local JWT token
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        
        await sendWhatsApp(user.phone, `🎉 Welcome, ${user.name}! Your account is created. You can now log in and start shopping.`);
        
        res.status(201).json({ 
            token, 
            message: 'Registration successful!',
            user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, pincodes: user.pincodes, approved: user.approved } 
        });

    } catch (err) {
        console.error('Register with OTP error:', err.message);
        if (err.code === 11000) {
            return res.status(409).json({ message: 'An account with this email/phone already exists. Please log in.' });
        }
        res.status(500).json({ message: 'Server error during OTP registration.' });
    }
});


// --- MODIFIED: Verify Firebase ID Token and handle auto-registration ---
app.post('/api/auth/verify-login-otp', async (req, res) => {
  try {
    const { firebaseToken } = req.body;
    if (!firebaseToken) {
      return res.status(400).json({ message: 'Firebase ID Token is required.' });
    }

    // 1. Verify the Firebase ID Token
    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    const phoneNumber = decodedToken.phone_number;
    
    if (!phoneNumber) {
      return res.status(401).json({ message: 'Firebase token missing phone number.' });
    }

    // 2. Find the user in the local database
    let user = await User.findOne({ phone: phoneNumber, role: 'user' });

    if (!user) {
        // *** Auto-Register New User (only for 'user' role via OTP) ***
        const randomString = crypto.randomBytes(8).toString('hex');
        const defaultName = `User-${phoneNumber.slice(-4)}`;
        // Create a temporary password hash (required by schema)
        const temporaryPasswordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
        
        user = await User.create({
            name: defaultName,
            // Create a unique placeholder email
            email: `${phoneNumber.substring(1).replace(/\+/g, '')}@temp-${randomString}.com`, 
            phone: phoneNumber,
            password: temporaryPasswordHash, 
            role: 'user',
            approved: true
        });
        console.log(`✅ Auto-registered new user: ${user.phone}`);
    }

    if (user.role !== 'user') {
        return res.status(403).json({ message: 'Phone login is restricted to user accounts.' });
    }
    
    if (user.role === 'seller' && !user.approved) {
      return res.status(403).json({ message: 'Seller account awaiting admin approval' });
    }

    // 3. Login successful, generate local JWT token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ 
        token, 
        user: { 
            id: user._id, 
            name: user.name, 
            email: user.email, 
            phone: user.phone, 
            role: user.role, 
            pincodes: user.pincodes, 
            approved: user.approved 
        } 
    });

  } catch (err) {
    let message = 'Error verifying Firebase token. Please ensure Phone Sign-in is enabled in Firebase Console.';
    if (err.code && err.code.startsWith('auth/')) {
        message = `Firebase Auth Error: ${err.message}`;
    }
    console.error('Verify Login OTP/Firebase Token Error:', err.message);
    res.status(401).json({ message: message });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role = 'user', pincodes } = req.body;
    if (!name || !password || !phone) return res.status(400).json({ message: 'Name, password, and phone number are required' });

    
    if (role === 'seller' && !email) {
        return res.status(400).json({ message: 'Email is required for seller registration.' });
    }
    if ((role === 'user' || role === 'delivery') && !phone) {
      return res.status(400).json({ message: 'Phone number is required for user/delivery registration.' });
    }

    let existingUser;
    if (role === 'seller') {
        existingUser = await User.findOne({ email });
    } else {
        existingUser = await User.findOne({ phone });
    }

    if (existingUser) {
      return res.status(409).json({ message: 'User with this email or phone number already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);

    let approved = true;
    if (role === 'seller') {
      approved = false;
    }


    const user = await User.create({ 
        name, 
        email, 
        password: hashed, 
        phone, 
        role, 
        pincodes: Array.isArray(pincodes) ? pincodes : [], 
        approved 
    });

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
      if (user && (user.role === 'user' || user.role === 'delivery')) {
        return res.status(403).json({ message: 'User/Delivery roles cannot log in with email. Please use phone number.' });
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
    const { name, phone, pincodes, pickupAddress } = req.body;
    const user = await User.findById(req.user._id);
    if (name) user.name = name;
    if (phone) user.phone = phone;
    if (pincodes && pincodes.length) user.pincodes = pincodes; // Works for sellers and delivery boys

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
        'Welcome Back! 🛍️ Ready to Shop?',
        `Hi ${user.name}! We've missed you. Your next great deal is waiting!`,
        { type: 'LOGIN_WELCOME' }
      );
    }
    res.json({ message: 'FCM token saved and welcome notification handled.' });
  } catch (err) {
    res.status(500).json({ message: 'Error saving FCM token', error: err.message });
  }
});


// --------------------------------------------------------------------------------
// --------- Category Routes (User's Requested Block) ----------
// --------------------------------------------------------------------------------

// Assuming you have imported your Mongoose models: Product and Category

// Node.js/Express Route: /api/categories

app.get('/api/categories', async (req, res) => {
    try {
        const { active, userPincode } = req.query;

        const categoryFilter = {};
        if (typeof active !== 'undefined') categoryFilter.isActive = active === 'true';

        let categories;

        if (userPincode) {
            // AGGREGATION: Find categories that are linked to products available in the userPincode
            categories = await Product.aggregate([
                // Stage 1: Filter products by Pincode and Active status
                { $match: {
                    isActive: true, 
                    pincodes: userPincode 
                }},
                // Stage 2: Group by Category ID to get a list of relevant categories
                { $group: { _id: '$category', count: { $sum: 1 } } },
                // Stage 3: Join back to the Category collection to get category details
                { $lookup: {
                    from: 'categories', // Collection name
                    localField: '_id',
                    foreignField: '_id',
                    as: 'categoryDetails'
                }},
                { $unwind: '$categoryDetails' },
                // Stage 4: Apply original category filters (e.g., isActive)
                { $match: { 
                    'categoryDetails.isActive': categoryFilter.isActive !== undefined ? categoryFilter.isActive : { $exists: true } 
                }},
                // Stage 5: Shape the output
                { $project: {
                    _id: '$categoryDetails._id',
                    name: '$categoryDetails.name',
                    slug: '$categoryDetails.slug',
                    isActive: '$categoryDetails.isActive',
                    image: '$categoryDetails.image',
                    type: '$categoryDetails.type',
                    sortOrder: '$categoryDetails.sortOrder',
                }},
                // Stage 6: Sort
                { $sort: { sortOrder: 1, name: 1 } }
            ]);

        } else {
            // Default: If no pincode, return all categories
            categories = await Category.find(categoryFilter)
                .sort({ sortOrder: 1, name: 1 })
                .select('name slug isActive image type sortOrder');
        }

        res.json(categories);
    } catch (err) {
        console.error('Error fetching categories with pincode filter:', err); 
        res.status(500).json({ message: 'Error fetching categories', error: err.message });
    }
});

app.get('/api/categories/:id', async (req, res) => {
    // This route does not need modification as it fetches a single category by ID.
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
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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


app.get('/api/products', async (req, res) => {
  try {
    const { search, minPrice, maxPrice, categoryId, brand, subcategoryId, sellerId, userPincode } = req.query;
    const { ObjectId } = mongoose.Types;

    // --- 1. Build initial match conditions (Pre-Pincode/Seller Join) ---
    const initialMatchStage = {};
    // Only show products that have at least one variant defined
    initialMatchStage['variants.0'] = { $exists: true };
    
    // 🔍 Search filter
    if (search) {
      initialMatchStage.$or = [
        { name: { $regex: search, $options: "i" } },
        { shortDescription: { $regex: search, $options: "i" } },
        { fullDescription: { $regex: search, $options: "i" } }
      ];
    }
    
    // 🏷️ Category filter
    if (categoryId && mongoose.isValidObjectId(categoryId)) {
      initialMatchStage.category = new ObjectId(categoryId);
    }

    // 🧩 Subcategory filter
    if (subcategoryId && mongoose.isValidObjectId(subcategoryId)) {
      // NOTE: This will match on both 'subcategory' and 'childCategory' fields
      initialMatchStage.$or = [
          { subcategory: new ObjectId(subcategoryId) },
          { childCategory: new ObjectId(subcategoryId) } 
      ];
    }

    // 🏭 Brand filter
    if (brand) initialMatchStage.brand = { $regex: brand, $options: "i" };

    // 👨‍💼 Seller filter
    if (sellerId && mongoose.isValidObjectId(sellerId)) {
      initialMatchStage.seller = new ObjectId(sellerId);
    }
    
    // Apply initial matching first
    const pipeline = [{ $match: initialMatchStage }];
    
    // --- 2. Build aggregation pipeline (Pincode/Seller Joining) ---

    const finalMatchStage = {}; // Will hold additional filters like minPrice/maxPrice
    
    // 🏠 If userPincode is given — join seller table first
    if (userPincode) {
      pipeline.push(
        {
          $lookup: {
            from: "users",
            localField: "seller",
            foreignField: "_id",
            as: "sellerDetails"
          }
        },
        // Only keep products where the seller is found
        { $unwind: "$sellerDetails" }, 
        {
          $match: {
            // ✅ Match by user’s pincode in the seller's allowed list
            "sellerDetails.pincodes": userPincode 
          }
        },
        { $addFields: { seller: "$sellerDetails" } },
        { $unset: "sellerDetails" }
      );
    } else {
      // 🔹 If no pincode, just join seller details without a pincode filter
      pipeline.push(
        {
          $lookup: {
            from: "users",
            localField: "seller",
            foreignField: "_id",
            as: "seller"
          }
        },
        { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } }
      );
    }

    // --- 3. Randomize order for homepage (If no specific filter like category is applied) ---
    // If we are looking for a sample (like for trending/bestsellers on the homepage)
    if (req.query.sample === 'true') {
        const limit = parseInt(req.query.limit) || 20;
        pipeline.push({ $sample: { size: limit } });
    }


    // --- 3.5. FIX: Derive price, originalPrice, and stock from variants ---
    pipeline.push({
        $addFields: {
            // ✅ Lowest Price: Minimum value of all variants.price
            price: { $min: "$variants.price" },
            
            // 🔹 Highest Original Price: Maximum value of all variants.originalPrice
            originalPrice: { $max: "$variants.originalPrice" }, 
            
            // टोटल स्टॉक की गणना
            stock: { $sum: "$variants.stock" }, 
            
            // Variants array को भी भेजें ताकि Flutter में ProductDetail काम कर सके
            variants: "$variants" 
        }
    });
    
    // --- 3.6. Price range filter (Applied AFTER deriving price from variants) ---
    if (minPrice || maxPrice) {
      finalMatchStage.price = {};
      if (minPrice) finalMatchStage.price.$gte = Number(minPrice);
      if (maxPrice) finalMatchStage.price.$lte = Number(maxPrice);
    }
    
    // Apply the price filter
    if(Object.keys(finalMatchStage).length > 0) {
        pipeline.push({ $match: finalMatchStage });
    }
    
    // --- 4. Enrich category & subcategory info ---
    pipeline.push(
      {
        $lookup: {
          from: "categories",
          localField: "category",
          foreignField: "_id",
          as: "category"
        }
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "subcategories",
          localField: "subcategory",
          foreignField: "_id",
          as: "subcategory"
        }
      },
      { $unwind: { path: "$subcategory", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          price: 1,         // Lowest Price
          originalPrice: 1, // Highest MRP
          images: 1,
          stock: 1,         // Total Stock
          unit: 1,
          brand: 1,
          variants: 1,      // Important for Flutter models
          shortDescription: 1,
          isTrending: 1,    // Important for filtering
          "seller._id": 1,
          "seller.name": 1,
          "seller.email": 1,
          "category.name": 1,
          "subcategory.name": 1,
          createdAt: 1
        }
      }
    );

    // --- 5. Execute query ---
    const products = await Product.aggregate(pipeline);
    res.json(products);
  } catch (err) {
    console.error("❌ Get Products Error:", err);
    res.status(500).json({ message: "Error fetching products" });
  }
});


app.get('/api/products/:id', async (req, res) => {
    try {
      const product = await Product.findById(req.params.id)
        .populate('seller', 'name email phone')
        .populate('category', 'name')
        .populate('subcategory', 'name');
      if (!product) return res.status(404).json({ message: 'Product not found' });
      res.json(product);
    } catch (err) {
      res.status(500).json({ message: 'Error fetching product details' });
    }
});


// [NEW] API Endpoint to get products available in a specific pincode
app.get('/api/products/pincode/:pincode', async (req, res) => {
    try {
        const userPincode = req.params.pincode;
        if (!userPincode) {
            return res.status(400).json({ message: 'Pincode is required for this search.' });
        }

        // --- Aggregation Pipeline for Pincode Filtering ---
        const products = await Product.aggregate([
            // Stage 1: Filter products by Pincode directly on the product document (new field)
            { $match: { 
                pincodes: userPincode,
                stock: { $gt: 0 } // Only show in-stock products
            }},
            // Stage 2: Join with Seller (User) details to get seller's name/info
            { $lookup: {
                from: "users",
                localField: "seller",
                foreignField: "_id",
                as: "seller"
            }},
            { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
            
            // Stage 3: Join with Category details
            { $lookup: {
                from: "categories",
                localField: "category",
                foreignField: "_id",
                as: "category"
            }},
            { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
            
            // Stage 4: Project only the necessary fields
            { $project: {
                name: 1,
                price: 1,
                originalPrice: 1,
                images: 1,
                stock: 1,
                unit: 1,
                brand: 1,
                shortDescription: 1,
                isTrending: 1,
                "seller.name": 1,
                "category.name": 1,
                createdAt: 1,
                pincodes: 1, // Show which pincodes this product covers
            }},
            // Stage 5: Sort by newest first
            { $sort: { createdAt: -1 } }
        ]);

        if (products.length === 0) {
            return res.status(404).json({ message: `No products available for delivery to pincode ${userPincode}.` });
        }

        res.json(products);
    } catch (err) {
        console.error('❌ Error fetching products by pincode:', err.message);
        res.status(500).json({ message: 'Error fetching products by pincode', error: err.message });
    }
});



app.get('/api/cart', protect, async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user._id }).populate('items.product');
    if (!cart) return res.status(404).json({ message: 'Cart not found' });
    res.json(cart);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching cart' });
  }
});

// server.js (POST /api/cart)

// server.js - app.post('/api/cart') ROUTE (Fixed)
// server.js - app.post('/api/cart') ROUTE (DEBUGGING VERSION)

app.post('/api/cart', protect, async (req, res) => {
    try {
        const { 
            productId, 
            qty = 1, 
            selectedVariant 
        } = req.body;
        
        // ✅ --- DEBUGGING LOGS START --- ✅
        console.log("--- ADD TO CART REQUEST RECEIVED ---");
        console.log("Request Body:", JSON.stringify(req.body, null, 2));
        console.log("User ID:", req.user._id);
        // ✅ --- DEBUGGING LOGS END --- ✅

        const selectedColor = selectedVariant ? selectedVariant.color : undefined;
        const selectedSize = selectedVariant ? selectedVariant.size : undefined;
        
        const product = await Product.findById(productId);
        if (!product) {
            console.log(`❌ FAILED: Product with ID ${productId} not found.`);
            return res.status(404).json({ message: 'Product not found' });
        }

        let cart = await Cart.findOne({ user: req.user._id });
        if (!cart) {
            cart = await Cart.create({ user: req.user._id, items: [] });
        }

        const itemIndex = cart.items.findIndex(item => 
            item.product.toString() === productId &&
            (item.selectedColor === selectedColor || (!item.selectedColor && !selectedColor)) &&
            (item.selectedSize === selectedSize || (!item.selectedSize && !selectedSize))
        );

        if (itemIndex > -1) {
            cart.items[itemIndex].qty += qty;
        } else {
            const hasColorOptions = product.variants.some(v => v.color && v.color.length > 0);
            const hasSizeOptions = product.variants.some(v => v.size && v.size.length > 0);

            if ((hasColorOptions && !selectedColor) || (hasSizeOptions && !selectedSize)) {
                let missing = [];
                if (hasColorOptions && !selectedColor) missing.push('Color');
                if (hasSizeOptions && !selectedSize) missing.push('Size');
                console.log(`❌ FAILED: Missing required variants: ${missing.join(' & ')}`);
                return res.status(400).json({ message: `Please select ${missing.join(' and ')}.` });
            }
            
            if (product.variants.length > 0) {
                const targetVariant = product.variants.find(v => 
                    (v.color === selectedColor || (!v.color && !selectedColor)) &&
                    (v.size === selectedSize || (!v.size && !selectedSize))
                );

                if (!targetVariant) {
                    console.log(`❌ FAILED: Variant combination not found.`);
                    console.log(`   - Received: color='${selectedColor}', size='${selectedSize}'`);
                    console.log(`   - Available Variants in DB:`, product.variants.map(v => ({color: v.color, size: v.size})));
                    return res.status(400).json({ message: 'The selected variant combination is not available.' });
                }

                if (targetVariant.stock < qty) {
                    console.log(`❌ FAILED: Insufficient stock for variant. Stock: ${targetVariant.stock}, Qty: ${qty}`);
                    return res.status(400).json({ message: `Insufficient stock for selected variant.` });
                }
            }

            cart.items.push({ 
                product: productId, 
                qty,
                selectedColor: selectedColor,
                selectedSize: selectedSize
            });
        }

        await cart.save();
        console.log("✅ SUCCESS: Cart updated successfully.");
        res.status(200).json(cart);
        
    } catch (err) {
        console.error("❌ CRITICAL ERROR in /api/cart:", err.message);
        res.status(500).json({ message: 'Error adding item to cart', error: err.message });
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

app.get('/api/orders/checkout-summary', protect, async (req, res) => {
  try {
    const { shippingAddressId, couponCode } = req.query;

    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      populate: {
        path: 'seller',
        select: 'pincodes'
      }
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }
    const shippingAddress = await Address.findById(shippingAddressId);
    if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });

    for (const item of cart.items) {
      if (!item.product || !item.product.seller) {
        return res.status(400).json({ message: `An item in your cart is no longer available.` });
      }
      const product = item.product;
      if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
        return res.status(400).json({
          message: `Sorry, delivery not available at your location for the product: "${product.name}"`
        });
      }
      if (product.stock < item.qty) {
        return res.status(400).json({ message: `Insufficient stock for product: ${product.name}` });
      }
    }

    const totalCartAmount = cart.items.reduce((sum, item) => sum + (item.product.price * item.qty), 0);

    let discountAmount = 0;
    const shippingFee = calculateShippingFee(shippingAddress.pincode);
    const totalTaxAmount = totalCartAmount * GST_RATE;

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
      }
    }

    let finalAmountForPayment = Math.max(0, totalCartAmount + shippingFee + totalTaxAmount - discountAmount);

    res.json({
      message: 'Checkout summary calculated successfully.',
      itemsTotal: totalCartAmount,
      totalShippingFee: shippingFee,
      totalTaxAmount: totalTaxAmount,
      totalDiscount: discountAmount,
      grandTotal: finalAmountForPayment,
    });

  } catch (err) {
    console.error('Checkout summary error:', err.message);
    if (err.message.includes('delivery not available') || err.message.includes('Insufficient stock') || err.message.includes('not available')) {
        return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Error calculating checkout summary', error: err.message });
  }
});

app.post('/api/orders/calculate-summary', protect, async (req, res) => {
  try {
    const { shippingAddressId, couponCode } = req.body; 

    // 1. Populate cart items to get full Product data AND Seller data
    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      // We explicitly select variants, shortDescription, and seller
      select: 'name variants shortDescription unit', 
      populate: {
        path: 'seller',
        select: 'pincodes'
      }
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }
    const shippingAddress = await Address.findById(shippingAddressId);
    if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });
    
    let totalCartAmount = 0; // Initialize total

    for (const item of cart.items) {
      const product = item.product;
      
      // CRITICAL CHECK: Ensure Product and Seller details are available
      if (!product || !product.seller) {
        return res.status(400).json({ message: `An item in your cart is invalid or its seller is inactive.` });
      }
      
      // 2. Find the selected variant using item's color and size
      let selectedVariant;
      
      if (product.variants && product.variants.length > 0) {
          selectedVariant = product.variants.find(v => 
              (v.color === item.selectedColor || (!v.color && !item.selectedColor)) && 
              (v.size === item.selectedSize || (!v.size && !item.selectedSize))
          );
      } else {
          // If product has NO variants defined in the array, something is wrong, or 
          // we are assuming a non-variant product might have been added by mistake 
          // (though cart POST prevents this now). 
          // We rely on the check below for 'selectedVariant'
          selectedVariant = null; 
      }
      
      // Check if variant was found (if it's a non-variant product, this should default to the only variant)
      if (!selectedVariant) {
          // If variants exist but the specific combination wasn't found (or the single variant array is empty)
          const variantDisplay = `${item.selectedColor || 'N/A'}/${item.selectedSize || 'N/A'}`;
          return res.status(400).json({ 
              message: `Invalid variant combination (${variantDisplay}) selected for product: ${product.name}.` 
          });
      }
      
      // 3. Validate and use the variant price/stock
      const variantPrice = selectedVariant.price;
      const variantStock = selectedVariant.stock;

      if (typeof variantPrice !== 'number' || variantPrice <= 0) {
           return res.status(400).json({ message: `Variant price is missing or invalid for product: ${product.name}` });
      }
      
      // Check delivery availability based on seller pincodes
      if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
        return res.status(400).json({
          message: `Sorry, delivery not available at your location for the product: "${product.name}"`
        });
      }
      
      // Use variant stock for check
      if (variantStock < item.qty) {
        return res.status(400).json({ message: `Insufficient stock for product: ${product.name}. Only ${variantStock} left.` });
      }
      
      totalCartAmount += variantPrice * item.qty; // Use validated price
    }

    // --- FINANCIAL CALCULATIONS (Unchanged) ---
    let discountAmount = 0;
    const totalCartAmountFinal = totalCartAmount || 0; 
    const shippingFee = calculateShippingFee(shippingAddress.pincode) || 0;
    const totalTaxAmount = totalCartAmountFinal * GST_RATE || 0;

    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: couponCode,
        isActive: true,
        expiryDate: { $gt: new Date() },
        minPurchaseAmount: { $lte: totalCartAmountFinal } 
      });

      if (coupon) {
        if (coupon.discountType === 'percentage') {
          discountAmount = totalCartAmountFinal * (coupon.discountValue / 100);
          if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
            discountAmount = coupon.maxDiscountAmount;
          }
        } else if (coupon.discountType === 'fixed') {
          discountAmount = coupon.discountValue;
        }
      }
    }

    let finalAmountForPayment = Math.max(0, totalCartAmountFinal + shippingFee + totalTaxAmount - discountAmount);

    res.json({
      message: 'Summary calculated successfully.',
      itemsTotal: totalCartAmountFinal,
      totalShippingFee: shippingFee,
      totalTaxAmount: totalTaxAmount,
      totalDiscount: discountAmount,
      grandTotal: finalAmountForPayment,
    });

  } catch (err) {
    console.error('POST Summary calculation error:', err.message);
    if (err.message.includes('delivery not available') || err.message.includes('Insufficient stock') || err.message.includes('Invalid variant combination') || err.message.includes('invalid or its seller is inactive')) {
        return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Error calculating order summary', error: err.message });
  }
});


app.post('/api/orders', protect, async (req, res) => {
  try {
    const { shippingAddressId, paymentMethod, couponCode } = req.body;

    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      // CRITICAL: Ensure we get variants for price calculation
      select: 'name price originalPrice variants category seller', 
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

    // --- Pre-order validation and grouping ---
    const ordersBySeller = new Map();
    let calculatedTotalCartAmount = 0; // Use a new variable for safety

    for (const item of cart.items) {
      const product = item.product;
      
      if (!product || !product.seller) {
        return res.status(400).json({ message: `An item in your cart is invalid or its seller is inactive.` });
      }

      // 1. Find the correct price/variant
      let itemPrice = product.price; // Fallback to top-level price (for legacy/non-variant data structure)
      let itemOriginalPrice = product.originalPrice; // Fallback for original price
      
      if (product.variants && product.variants.length > 0) {
          const selectedVariant = product.variants.find(v => 
              (v.color === item.selectedColor || (!v.color && !item.selectedColor)) && 
              (v.size === item.selectedSize || (!v.size && !item.selectedSize))
          );
          
          if (!selectedVariant) {
             return res.status(400).json({ message: `Invalid variant combination selected for product: ${product.name}.` });
          }
          itemPrice = selectedVariant.price;
          itemOriginalPrice = selectedVariant.originalPrice;
          
          // Use variant stock for the check
          if (selectedVariant.stock < item.qty) {
            return res.status(400).json({ message: `Insufficient stock for product: ${product.name} variant.` });
          }
      } else {
          // If no variants defined, use the legacy check
          if (product.stock < item.qty) {
            return res.status(400).json({ message: `Insufficient stock for product: ${product.name}` });
          }
      }

      if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
        return res.status(400).json({ message: `Sorry, delivery not available at your location for the product: "${product.name}"` });
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
        originalPrice: itemOriginalPrice, // Use dynamically found original price
        price: itemPrice, // Use dynamically found price
        category: product.category,
        selectedColor: item.selectedColor,
        selectedSize: item.selectedSize,
      });

      sellerOrder.totalAmount += itemPrice * item.qty;
      calculatedTotalCartAmount += itemPrice * item.qty;
    }
    
    // Use the correctly calculated total
    const totalCartAmount = calculatedTotalCartAmount; 
    
    // --- Coupon, Shipping & Tax Calculations ---
    let discountAmount = 0;
    const shippingFee = calculateShippingFee(shippingAddress.pincode); 
    const totalTaxAmount = totalCartAmount * GST_RATE;
    
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
      }
    }
    
    let finalAmountForPayment = Math.max(0, totalCartAmount + shippingFee + totalTaxAmount - discountAmount);
    
    let effectivePaymentMethod = paymentMethod;
    if (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) {
      effectivePaymentMethod = 'cod';
    }

    let razorpayOrder = null;
    if (effectivePaymentMethod === 'razorpay') {
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
    
    let remainingDiscount = discountAmount;
    let remainingShippingFee = shippingFee;
    let remainingTaxAmount = totalTaxAmount; 

    // --- Create Sub-Orders for Each Seller ---
    for (const [sellerId, sellerData] of ordersBySeller.entries()) {
      
      // ✅ FIX 1: Protect against division by zero (NaN generation)
      const proportion = (totalCartAmount > 0) ? sellerData.totalAmount / totalCartAmount : 0; 

      const sellerDiscount = remainingDiscount * proportion;
      const sellerShippingFee = remainingShippingFee * proportion;
      const sellerTaxAmount = remainingTaxAmount * proportion;

      remainingDiscount -= sellerDiscount;
      remainingShippingFee -= sellerShippingFee;
      remainingTaxAmount -= sellerTaxAmount;

      const isCodOrFree = effectivePaymentMethod === 'cod' || finalAmountForPayment === 0;
      
      // ✅ FIX 2: Ensure all final numbers are rounded and cast to a valid float
      const totalAmountFloat = parseFloat((sellerData.totalAmount || 0).toFixed(2));
      const shippingFeeFloat = parseFloat((sellerShippingFee || 0).toFixed(2));
      const taxAmountFloat = parseFloat((sellerTaxAmount || 0).toFixed(2));
      const discountAmountFloat = parseFloat((sellerDiscount || 0).toFixed(2));
      
      const orderGrandTotal = totalAmountFloat + shippingFeeFloat + taxAmountFloat - discountAmountFloat;

      const order = new Order({
        user: req.user._id,
        seller: sellerData.seller,
        orderItems: sellerData.orderItems, 
        shippingAddress: fullAddress,
        pincode: shippingAddress.pincode,
        paymentMethod: effectivePaymentMethod,
        totalAmount: totalAmountFloat, // Use pre-processed float
        taxRate: GST_RATE,
        taxAmount: taxAmountFloat, // Use pre-processed float
        couponApplied: couponCode,
        discountAmount: discountAmountFloat, // Use pre-processed float
        shippingFee: shippingFeeFloat, // Use pre-processed float
        paymentId: razorpayOrder ? razorpayOrder.id : (isCodOrFree ? `cod_${crypto.randomBytes(8).toString('hex')}` : undefined),
        paymentStatus: isCodOrFree ? 'completed' : 'pending',
        deliveryStatus: isCodOrFree ? 'Pending' : 'Payment Pending',
        history: [{ status: isCodOrFree ? 'Pending' : 'Payment Pending' }]
      });
      await order.save();
      createdOrders.push(order);

      const orderIdShort = order._id.toString().slice(-6);

      // --- Post-creation actions (stock update, notifications) ---
      if (isCodOrFree) {
        
        for(const item of sellerData.orderItems) {
            // NOTE: This updates the overall product stock, not the variant stock.
            await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
        }

        const userMessage = `✅ Your COD order #${orderIdShort} has been successfully placed! Grand Total: ₹${orderGrandTotal.toFixed(2)}.`;
        const sellerMessage = `🎉 New Order (COD)!\nYou've received a new order #${orderIdShort}. Item Subtotal: ₹${totalAmountFloat.toFixed(2)}.`;
        
        await sendWhatsApp(req.user.phone, userMessage);
        await sendWhatsApp(sellerData.seller.phone, sellerMessage);
        await notifyAdmin(`Admin Alert: New COD order #${orderIdShort} placed.`);

        try {
            const orderPincode = shippingAddress.pincode;
            
            await DeliveryAssignment.create({
              order: order._id,
              deliveryBoy: null,
              status: 'Pending',
              pincode: orderPincode,
              history: [{ status: 'Pending' }]
            });
            
            const nearbyDeliveryBoys = await User.find({
              role: 'delivery', approved: true, pincodes: orderPincode
            }).select('fcmToken');
            const deliveryTokens = nearbyDeliveryBoys.map(db => db.fcmToken).filter(Boolean);
            
            if (deliveryTokens.length > 0) {
              await sendPushNotification(
                  deliveryTokens,
                  'New Delivery Available! 🛵',
                  `A new order (#${orderIdShort}) is available for pickup in your area (Pincode: ${orderPincode}).`,
                  { orderId: order._id.toString(), type: 'NEW_DELIVERY_AVAILABLE' }
              );
            }
        } catch (deliveryErr) {
            console.error('Failed to create delivery assignment or notify boys:', deliveryErr.message);
        }
        
      } else {
        const userMessage = `🔔 Your order #${orderIdShort} is awaiting payment completion via Razorpay.`;
        await sendWhatsApp(req.user.phone, userMessage);
      }
    }
    // -------------------------------------------------------------

    if (effectivePaymentMethod === 'cod') {
      await Cart.deleteOne({ user: req.user._id }); 
    }

    res.status(201).json({
      message: effectivePaymentMethod === 'razorpay' ? 'Order initiated, awaiting payment verification.' : 'Orders created successfully',
      orders: createdOrders.map(o => o._id),
      razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount, key_id: process.env.RAZORPAY_KEY_ID } : undefined,
      user: { name: req.user.name, email: req.user.email, phone: req.user.phone },
      paymentMethod: effectivePaymentMethod,
      grandTotal: finalAmountForPayment,
      itemsTotal: totalCartAmount,
      totalShippingFee: shippingFee,
      totalTaxAmount: totalTaxAmount,
      totalDiscount: discountAmount
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
      const grandTotal = (order.totalAmount + order.shippingFee + order.taxAmount) - order.discountAmount;

      return { 
        ...order, 
        displayImage: image,
        grandTotal: grandTotal
      };
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

app.get('/api/orders/:id/payment-status', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    // Ensure the user owns this order
    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ paymentStatus: order.paymentStatus });

  } catch (err) {
    res.status(500).json({ message: 'Error fetching payment status', error: err.message });
  }
});

// -------- Cancel order with auto/prepaid refund or COD manual refund --------
app.put('/api/orders/:id/cancel', protect, async (req, res) => {
  try {
    const { upiId } = req.body; // optional: user can provide UPI when cancelling COD
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id }).populate('seller', 'phone');

    if (!order) return res.status(404).json({ message: 'Order not found or you do not have permission' });
    if (['Cancelled', 'Delivered', 'Shipped'].includes(order.deliveryStatus)) {
      return res.status(400).json({ message: `Cannot cancel an order that is already ${order.deliveryStatus}` });
    }

    // Mark cancelled
    order.deliveryStatus = 'Cancelled';
    order.history.push({ status: 'Cancelled by user', timestamp: new Date() });

    // Cancel any assigned delivery
    try {
      await DeliveryAssignment.findOneAndUpdate(
        { order: order._id },
        { $set: { status: 'Cancelled' }, $push: { history: { status: 'Cancelled', timestamp: new Date() } } }
      );
    } catch (assignErr) {
      console.error('Error cancelling delivery assignment:', assignErr.message);
    }

    let refundMessage = '';
    const isPrepaid = ['razorpay', 'razorpay_cod'].includes(order.paymentMethod);

    // ---------- Prepaid: Attempt auto refund via Razorpay ----------
    if (isPrepaid && order.paymentStatus === 'completed') {
      try {
        const orderGrandTotal = (Number(order.totalAmount || 0) + Number(order.shippingFee || 0) + Number(order.taxAmount || 0)) - Number(order.discountAmount || 0);
        const refundableAmount = orderGrandTotal - (Number(order.totalRefunded || 0));

        if (refundableAmount > 0 && order.paymentId) {
          const refund = await razorpay.payments.refund(order.paymentId, {
            amount: Math.round(refundableAmount * 100),
            speed: 'normal',
            notes: { reason: 'Order cancelled by user' }
          });

          const newRefundEntry = {
            amount: (refund.amount || 0) / 100,
            reason: 'Order cancelled by user (auto refund)',
            status: refund.status === 'processed' ? 'completed' : 'processing',
            razorpayRefundId: refund.id,
            processedBy: req.user._id,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          order.refunds.push(newRefundEntry);
          order.totalRefunded = (order.totalRefunded || 0) + newRefundEntry.amount;
          order.paymentStatus = 'refunded';
          refundMessage = ' Your payment has been automatically refunded.';
        } else {
          // nothing to refund
          refundMessage = ' No refundable amount found.';
        }
      } catch (refundErr) {
        console.error("Auto-refund failed:", refundErr && refundErr.message ? refundErr.message : refundErr);
        refundMessage = ' Refund will be processed manually after admin approval.';
        await notifyAdmin(`⚠️ Auto-refund FAILED for cancelled order #${order._id}. Error: ${refundErr.message || refundErr}`);
      }
    }

    // ---------- COD flow: request manual refund and optionally capture UPI ----------
    if (order.paymentMethod === 'cod') {
      const refundEntry = {
        amount: Number(order.totalAmount || 0),
        reason: 'Order cancelled (COD)',
        status: 'requested', // requested -> user to submit UPI or already provided
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (upiId) {
        refundEntry.upiId = upiId;
        refundEntry.notes = `UPI ID provided by user: ${upiId}`;
        refundEntry.status = 'pending'; // pending admin approval
        refundMessage = ` COD order cancelled. Refund will be processed manually to ${upiId} after admin approval.`;
      } else {
        refundMessage = ' COD order cancelled. Please provide your UPI ID for manual refund.';
      }

      order.refunds.push(refundEntry);
      order.paymentStatus = 'pending';
    }

    await order.save();

    // ---------- Restore stock for cancelled items ----------
    try {
      for (const item of order.orderItems) {
        // If product has variants and you store variant-level stock, adjust accordingly.
        // Here we assume top-level stock decrement was used — adjust if using variant-specific stock.
        await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
      }
    } catch (stockErr) {
      console.error('Error restoring stock after cancel:', stockErr.message || stockErr);
    }

    // ---------- Notify seller & admin ----------
    try {
      const orderIdShort = order._id.toString().slice(-6);
      if (order.seller && order.seller.phone) {
        await sendWhatsApp(order.seller.phone, `Order #${orderIdShort} has been cancelled by the customer.`);
      }
      await notifyAdmin(`📦 Order #${order._id} cancelled by user. ${refundMessage}`);
    } catch (notifyErr) {
      console.error('Notification error after cancel:', notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
    }

    res.json({ message: `Order cancelled successfully.${refundMessage}`, order });
  } catch (err) {
    console.error('Cancel Order Error:', err && err.message ? err.message : err);
    res.status(500).json({ message: 'Error cancelling order' });
  }
});


// -------- User submits UPI for COD refund --------
app.put('/api/orders/:id/submit-upi', protect, async (req, res) => {
  try {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ message: 'UPI ID required' });

    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const pendingRefund = order.refunds.find(r => r.status === 'requested' && (!r.upiId));
    if (!pendingRefund) return res.status(400).json({ message: 'No pending COD refund found or UPI already submitted' });

    pendingRefund.upiId = upiId;
    pendingRefund.notes = `UPI submitted by user: ${upiId}`;
    pendingRefund.status = 'pending'; // waiting admin approval
    pendingRefund.updatedAt = new Date();

    order.history.push({ status: 'UPI Submitted for COD Refund', timestamp: new Date() });

    await order.save();

    await notifyAdmin(`📩 UPI ID submitted for COD refund: ${upiId} (Order #${order._id})`);
    res.json({ message: 'UPI ID submitted successfully. Awaiting admin approval.' });
  } catch (err) {
    console.error('Submit UPI error:', err && err.message ? err.message : err);
    res.status(500).json({ message: 'Error submitting UPI ID' });
  }
});



// --------- Payments Routes ----------

/**
 * Handles all logic for a successful payment.
 * @param {string} order_id - The Razorpay Order ID.
 * @param {string} payment_id - The Razorpay Payment ID.
 */
async function handleSuccessfulPayment(order_id, payment_id) {
    console.log(`Handling successful payment for Razorpay Order ID: ${order_id}`);
    const orders = await Order.find({ paymentId: order_id, paymentStatus: 'pending' });

    if (!orders || orders.length === 0) {
      console.log(`No pending orders found for Razorpay Order ID: ${order_id}. Might be already processed.`);
      return;
    }
    
    const paymentHistoryEntries = [];
    let customerId = orders[0].user;
    
    for (const order of orders) {
      // 1. Update Order Status
      order.paymentStatus = 'completed';
      order.deliveryStatus = 'Pending';
      order.history.push({ status: 'Payment Completed', note: 'Razorpay verification successful.' });
      order.paymentId = payment_id;
      await order.save();
      
      // 2. Deduct Stock
      for(const item of order.orderItems) {
        await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
      }

      // 3. Create Delivery Assignment
      try {
        const orderPincode = order.pincode;
        await DeliveryAssignment.create({
          order: order._id,
          deliveryBoy: null,
          status: 'Pending',
          pincode: orderPincode,
          history: [{ status: 'Pending' }]
        });

        const nearbyDeliveryBoys = await User.find({ role: 'delivery', approved: true, pincodes: orderPincode }).select('fcmToken');
        const deliveryTokens = nearbyDeliveryBoys.map(db => db.fcmToken).filter(Boolean);
        
        if (deliveryTokens.length > 0) {
          await sendPushNotification(
            deliveryTokens,
            'New Delivery Available! 🛵',
            `A new paid order (#${order._id.toString().slice(-6)}) is available for pickup.`,
            { orderId: order._id.toString(), type: 'NEW_DELIVERY_AVAILABLE' }
          );
        }
      } catch (deliveryErr) {
        console.error('Failed to create delivery assignment or notify boys:', deliveryErr.message);
      }

      // 4. Send Seller Notifications
      const seller = await User.findById(order.seller).select('phone fcmToken name');
      const sellerMessage = `🎉 New Paid Order!\nYou've received a new order #${order._id.toString().slice(-6)}. Item Total: ₹${order.totalAmount.toFixed(2)}.`;
      await sendWhatsApp(seller.phone, sellerMessage);

      // 5. Add to Payment History
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
    
    // 6. Clear Cart
    await Cart.deleteOne({ user: customerId });
    
    // 7. Final User Notification
    const customerInfo = await User.findById(customerId).select('name phone fcmToken');
    if (customerInfo) {
      await sendWhatsApp(customerInfo.phone, `✅ Your payment has been confirmed and your order is being processed! Thank you, ${customerInfo.name}!`);
      await sendPushNotification(customerInfo.fcmToken, 'Payment Confirmed! ✅', `Your order is now being processed!`);
    }
}

/**
 * Handles all logic for a failed payment.
 * @param {string} order_id - The Razorpay Order ID.
 */
async function handleFailedPayment(order_id) {
    console.log(`Handling failed payment for Razorpay Order ID: ${order_id}`);
    const ordersToFail = await Order.find({ paymentId: order_id, paymentStatus: 'pending' });

    if (!ordersToFail || ordersToFail.length === 0) {
        console.log(`No pending orders to fail for Razorpay Order ID: ${order_id}.`);
        return;
    }

    for (const order of ordersToFail) {
        order.paymentStatus = 'failed';
        order.deliveryStatus = 'Cancelled';
        order.history.push({ status: 'Payment Failed', note: 'Razorpay verification failed. Order cancelled.' });
        await order.save();
        
        console.log(`Order ${order._id} payment failed. Status set to Failed/Cancelled. Cart preserved.`);
        await notifyAdmin(`Payment FAILED for Order #${order._id.toString().slice(-6)}. Status set to Failed/Cancelled.`);
        
        const customerInfo = await User.findById(order.user).select('phone fcmToken');
        if (customerInfo && customerInfo.phone) {
            await sendWhatsApp(customerInfo.phone, `❌ Your payment for order #${order._id.toString().slice(-6)} failed. Your items are still in your cart. Please try again.`);
        }
    }
}


app.post('/api/payment/verify', async (req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${order_id}|${payment_id}`);
    const digest = shasum.digest('hex');

    if (digest === signature) {
      await handleSuccessfulPayment(order_id, payment_id);
      return res.json({ status: 'success', message: 'Payment verified successfully' });
    } else {
      await handleFailedPayment(order_id);
      return res.status(400).json({ status: 'failure', message: 'Payment verification failed' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Error verifying payment', error: err.message });
  }
});

// --- [NEW] RAZORPAY WEBHOOK HANDLER ---
app.post('/api/payment/razorpay-webhook', async (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    console.log('Razorpay webhook called!');

    try {
        const shasum = crypto.createHmac('sha256', secret);
        shasum.update(JSON.stringify(req.body));
        const digest = shasum.digest('hex');

        if (digest === req.headers['x-razorpay-signature']) {
            console.log('Webhook signature verified.');
            const event = req.body.event;
            const payload = req.body.payload;

            // Handle different events
            switch (event) {
                case 'payment.captured':
                    const paymentEntity = payload.payment.entity;
                    await handleSuccessfulPayment(paymentEntity.order_id, paymentEntity.id);
                    break;
                case 'payment.failed':
                    const failedPaymentEntity = payload.payment.entity;
                    await handleFailedPayment(failedPaymentEntity.order_id);
                    break;
                case 'payment_link.paid':
                    const linkEntity = payload.payment_link.entity;
                    const orderId = linkEntity.notes.order_id;
                    const paymentId = linkEntity.payments.length > 0 ? linkEntity.payments[0].payment_id : null;

                    if (orderId) {
                      const order = await Order.findById(orderId);
                      if (order && order.paymentStatus !== 'completed') {
                          order.paymentStatus = 'completed';
                          order.paymentMethod = 'razorpay_cod';
                          if (paymentId) {
                            order.paymentId = paymentId;
                          }
                          await order.save();
                          console.log(`COD Order ${orderId} updated to paid via webhook.`);
                          
                          const customerInfo = await User.findById(order.user).select('name phone fcmToken');
                          if (customerInfo) {
                            await sendWhatsApp(customerInfo.phone, `✅ We've received your payment for order #${order._id.toString().slice(-6)}. Thank you!`);
                          }
                      }
                    }
                    break;
                default:
                    console.log(`Unhandled webhook event: ${event}`);
            }

            res.status(200).json({ status: 'ok' });
        } else {
            console.error('Webhook signature validation failed.');
            res.status(400).send('Invalid signature');
        }
    } catch (error) {
        console.error('Error in Razorpay webhook handler:', error.message);
        res.status(500).send('Webhook processing error');
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

    // ✅ TOTAL REVENUE (Delivered orders only)
    const totalRevenueResult = await Order.aggregate([
      { 
        $match: { 
          seller: new mongoose.Types.ObjectId(sellerId), 
          deliveryStatus: 'Delivered', 
          paymentStatus: 'completed' 
        } 
      },
      { 
        $group: { 
          _id: null, 
          totalSales: { $sum: "$totalAmount" } 
        } 
      }
    ]);
    const totalRevenue = totalRevenueResult[0]?.totalSales || 0;

    const platformCommission = totalRevenue * PLATFORM_COMMISSION_RATE;
    const netEarnings = totalRevenue - platformCommission;

    // ✅ PROCESSED PAYOUTS
    const totalPayoutsResult = await Payout.aggregate([
      { 
        $match: { 
          seller: new mongoose.Types.ObjectId(sellerId), 
          status: 'processed' 
        } 
      },
      { 
        $group: { 
          _id: null, 
          totalProcessed: { $sum: "$amount" } 
        } 
      }
    ]);
    const totalPayouts = totalPayoutsResult[0]?.totalProcessed || 0;

    // ✅ PENDING PAYOUTS (NEW)
    const pendingPayoutsResult = await Payout.aggregate([
      { 
        $match: { 
          seller: new mongoose.Types.ObjectId(sellerId), 
          status: 'pending' 
        } 
      },
      { 
        $group: { 
          _id: null, 
          totalPending: { $sum: "$amount" } 
        } 
      }
    ]);
    const pendingPayouts = pendingPayoutsResult[0]?.totalPending || 0;

    // ✅ CALCULATE BALANCES
    const currentBalance = netEarnings - totalPayouts;
    const availableBalance = Math.max(0, currentBalance - pendingPayouts);

    // ✅ PAYOUT HISTORY
    const payouts = await Payout.find({ seller: sellerId }).sort({ createdAt: -1 });

    // ✅ ADDITIONAL STATS (NEW)
    const totalOrdersResult = await Order.aggregate([
      { 
        $match: { 
          seller: new mongoose.Types.ObjectId(sellerId),
          deliveryStatus: 'Delivered'
        } 
      },
      { 
        $group: { 
          _id: null, 
          totalOrders: { $sum: 1 } 
        } 
      }
    ]);
    const totalOrders = totalOrdersResult[0]?.totalOrders || 0;

    res.json({
      // Basic Financials
      totalRevenue: totalRevenue,
      netEarnings: netEarnings,
      platformCommission: platformCommission,
      totalPayouts: totalPayouts,
      
      // Balances (NEW FIELDS)
      currentBalance: currentBalance,
      pendingPayouts: pendingPayouts,
      availableBalance: availableBalance,
      
      // Additional Stats (NEW)
      totalOrders: totalOrders,
      commissionRate: PLATFORM_COMMISSION_RATE,
      
      // Payout History
      payouts: payouts,
      
      // Payout Limits (NEW)
      payoutLimits: {
        minimumPayout: 100,
        maximumPayout: availableBalance
      }
    });

  } catch (err) {
    console.error('Error fetching seller financials:', err.message);
    res.status(500).json({ message: 'Error fetching financial data', error: err.message });
  }
});

// ... (Assumed imports: Product, Category, User models, generateUniqueSku function, protect middleware, etc.)

// ... (Assumed imports)

app.post('/api/seller/products',
  protect,
  authorizeRole('seller', 'admin'),
  checkSellerApproved,
  productUpload, // Handles multiple uploads: images[], video, variantImages[]
  async (req, res) => {
    try {
      const {
        productTitle, brand, category, subcategory, childCategory,
        shortDescription, fullDescription, unit,
        // Main product details that are now part of each variant
        // mrp, sellingPrice, stockQuantity,
        variants, // ✅ EXPECT a JSON string array of variants
        videoLink, specifications, shippingWeight, shippingLength,
        shippingWidth, shippingHeight, shippingType, warranty,
        returnPolicy, tags, serviceDurationMinutes,
      } = req.body;

      // --- 1. Basic Validation ---
      if (!productTitle || !category || !variants) {
        return res.status(400).json({ message: 'Product title, category, and variants are required.' });
      }

      // --- 2. Category and Type Validation ---
      const parentCategory = await Category.findById(category);
      if (!parentCategory) {
        return res.status(404).json({ message: 'Selected category not found.' });
      }
      if (parentCategory.type === 'service' && (!serviceDurationMinutes || parseInt(serviceDurationMinutes) <= 0)) {
        return res.status(400).json({ message: 'Services must have a valid "Service Duration (in minutes)".' });
      } else if (parentCategory.type === 'product' && !unit) {
        return res.status(400).json({ message: 'Products must have a "Unit" (e.g., kg, pcs).' });
      }
      if (!req.files.images || req.files.images.length === 0) {
        return res.status(400).json({ message: 'At least one main product image is required.' });
      }

      // --- 3. Process Uploaded Files ---
      const mainImages = req.files.images.map(file => ({
        url: file.path,
        publicId: file.filename,
      }));
      const variantImages = (req.files.variantImages || []).map(file => ({
        url: file.path,
        publicId: file.filename,
      }));
      let uploadedVideo = null;
      if (req.files.video && req.files.video.length > 0) {
        const videoFile = req.files.video[0];
        uploadedVideo = { url: videoFile.path, publicId: videoFile.filename };
      }

      // --- 4. Parse and Create Product Variants ---
      const parsedVariants = JSON.parse(variants);
      if (!Array.isArray(parsedVariants) || parsedVariants.length === 0) {
        return res.status(400).json({ message: 'At least one product variant is required.' });
      }

      const productVariants = parsedVariants.map((variant, index) => {
        if (!variant.price || !variant.stock) {
          throw new Error(`Variant #${index + 1} must have a price and stock.`);
        }
        if (variant.originalPrice && parseFloat(variant.originalPrice) < parseFloat(variant.price)) {
          throw new Error(`MRP cannot be less than selling price for variant #${index + 1}.`);
        }
        return {
          color: variant.color || null,
          size: variant.size || null,
          storage: variant.storage || null,
          price: parseFloat(variant.price),
          originalPrice: variant.originalPrice ? parseFloat(variant.originalPrice) : null,
          stock: parseInt(variant.stock),
          // ✅ Assign an uploaded image to this variant
          image: variantImages[index] ? variantImages[index] : null
        };
      });

      // --- 5. Determine Top-Level Price and Stock from Variants ---
      const firstVariant = productVariants[0];
      const totalStock = productVariants.reduce((sum, v) => sum + v.stock, 0);

      // --- 6. Prepare Final Product Data ---
      const finalSubcategory = childCategory || subcategory;
      const productData = {
        name: productTitle,
        sku: generateUniqueSku(category, productTitle),
        brand,
        category,
        subcategory: finalSubcategory,
        // Set main price/stock from the first variant
        price: firstVariant.price,
        originalPrice: firstVariant.originalPrice,
        stock: totalStock,
        unit: parentCategory.type === 'product' ? unit : undefined,
        shortDescription,
        fullDescription,
        images: mainImages, // Main gallery images
        uploadedVideo,
        videoLink,
        variants: productVariants, // ✅ Save the detailed variants array
        seller: req.user._id,
        pincodes: req.user.pincodes || [],
        serviceDurationMinutes: parentCategory.type === 'service' ? parseInt(serviceDurationMinutes) : undefined,
        specifications: specifications ? JSON.parse(specifications) : {},
        shippingDetails: { /* ... your shipping logic ... */ },
        otherInformation: {
          tags: tags ? JSON.parse(tags) : [],
          warranty: warranty || null,
          returnPolicy: returnPolicy || 'Non-Returnable',
        },
      };

      // --- 7. Create Product and Send Response ---
      const product = await Product.create(productData);
      res.status(201).json(product);

    } catch (err) {
      console.error('Create product error:', err);
      if (err.name === 'ValidationError' || err.message.includes('must have a price and stock')) {
        return res.status(400).json({ message: 'Validation failed', error: err.message });
      }
      res.status(500).json({ message: 'Error creating product', error: err.message });
    }
  }
);

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
    const { 
      productTitle, brand, category, subcategory, childCategory,
      shortDescription, fullDescription, unit, videoLink, specifications,
      shippingWeight, shippingLength, shippingWidth, shippingHeight, shippingType,
      warranty, returnPolicy, tags, serviceDurationMinutes, isTrending,
      variants, imagesToDelete 
    } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // --- Access Control ---
    if (req.user.role === 'seller' && product.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied: You do not own this product' });
    }
    
    // --- 1. Image Deletion (Main Images) ---
    if (imagesToDelete) {
      const idsToDelete = Array.isArray(imagesToDelete) ? imagesToDelete : [imagesToDelete];
      await Promise.all(idsToDelete.map(publicId => cloudinary.uploader.destroy(publicId)));
      product.images = product.images.filter(img => !idsToDelete.includes(img.publicId));
    }
    
    // --- 2. New Main Image/Video Upload ---
    if (req.files.images && req.files.images.length > 0) {
      const newImages = req.files.images.map(file => ({ url: file.path, publicId: file.filename }));
      product.images.push(...newImages);
    }
    if (req.files.video && req.files.video.length > 0) {
      const newVideoFile = req.files.video[0];
      if (product.uploadedVideo && product.uploadedVideo.publicId) {
        await cloudinary.uploader.destroy(product.uploadedVideo.publicId, { resource_type: 'video' });
      }
      product.uploadedVideo = { url: newVideoFile.path, publicId: newVideoFile.filename };
    }
    
    // --- 3. Variant Update (CRITICAL) ---
    let totalStock = 0;
    let defaultPrice = product.price;
    let defaultOriginalPrice = product.originalPrice;

    if (variants) {
        const parsedVariants = JSON.parse(variants);
        if (!Array.isArray(parsedVariants) || parsedVariants.length === 0) {
            return res.status(400).json({ message: 'At least one product variant is required in the update.' });
        }
        
        const variantImagesFiles = req.files.variantImages || [];
        
        const updatedVariants = parsedVariants.map((variant, index) => {
            if (!variant.price || !variant.stock) {
                throw new Error(`Variant #${index + 1} must have a price and stock.`);
            }
            if (variant.originalPrice && parseFloat(variant.originalPrice) < parseFloat(variant.price)) {
                throw new Error(`MRP cannot be less than selling price for variant #${index + 1}.`);
            }
            
            const variantStock = parseInt(variant.stock);
            totalStock += variantStock;
            
            // ⭐️ CRITICAL FIX: Handle existing image ID and new image upload ⭐️
            let variantImagesData = [];
            const newImageFile = variantImagesFiles[index];
            
            if (newImageFile) {
                // OPTION A: If a NEW file is uploaded for this index, use it (overwriting any previous image)
                variantImagesData = [{ url: newImageFile.path, publicId: newImageFile.filename }];
                
                // OPTIONAL: If the old image existed, delete it from Cloudinary (requires old publicId to be passed back)
                // Since the frontend isn't explicitly passing old Public IDs for deletion, we skip immediate deletion
            
            } else if (variant.imagePublicId && variant.imageUrl) {
                // OPTION B: If no new file, but existing data (PublicId and URL) was passed from the frontend, retain it.
                variantImagesData = [{ url: variant.imageUrl, publicId: variant.imagePublicId }];
            }

            const variantObj = {
                _id: variant._id, // Keep existing ID if present
                color: variant.color || null,
                size: variant.size || null,
                price: parseFloat(variant.price),
                originalPrice: variant.originalPrice ? parseFloat(variant.originalPrice) : null,
                stock: variantStock,
                images: variantImagesData // <-- FIX: Save the correct image array here
            };
            
            return variantObj;
        });

        // Replace the entire variants array
        product.variants = updatedVariants;
        
        // Update product-level summaries from the first variant
        if (updatedVariants.length > 0) {
            defaultPrice = updatedVariants[0].price;
            defaultOriginalPrice = updatedVariants[0].originalPrice;
        }
    }
    
    // --- 4. Update Scalar Fields ---
    if (productTitle) product.name = productTitle;
    if (brand) product.brand = brand;
    if (shortDescription) product.shortDescription = shortDescription;
    if (fullDescription) product.fullDescription = fullDescription;
    if (unit) product.unit = unit;
    if (videoLink) product.videoLink = videoLink;
    if (category) product.category = category;
    if (returnPolicy) product.otherInformation.returnPolicy = returnPolicy;
    if (typeof isTrending !== 'undefined') product.isTrending = isTrending;
    if (serviceDurationMinutes) product.serviceDurationMinutes = parseInt(serviceDurationMinutes);
    if (specifications) product.specifications = specifications ? JSON.parse(specifications) : {};
    if (tags) product.otherInformation.tags = tags ? JSON.parse(tags) : [];

    const finalSubcategory = childCategory || subcategory;
    if (finalSubcategory) product.subcategory = finalSubcategory;

    // Update derived fields
    product.price = defaultPrice;
    product.originalPrice = defaultOriginalPrice;
    product.stock = totalStock;
    
    await product.save();
    res.json(product);
  } catch (err) {
    console.error('Update product error:', err.message);
    if (err.name === 'ValidationError' || err.message.includes('must have a price and stock')) {
        return res.status(400).json({ message: 'Validation failed', error: err.message });
    }
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

    const finalAmount = (order.totalAmount + order.shippingFee + order.taxAmount) - order.discountAmount;

    const doc = new PDFDocument({
      size: [288, 432],
      margins: { top: 20, bottom: 20, left: 20, right: 20 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="label-${orderId}.pdf"`);

    doc.pipe(res);

    doc.fontSize(14).font('Helvetica-Bold').text(`Order: #${orderId.slice(-8)}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Payment: ${order.paymentMethod.toUpperCase()}`, { align: 'center' });

    if (order.paymentMethod === 'cod' || order.paymentMethod === 'razorpay_cod') {
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

app.get('/api/delivery/available-orders', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const myPincodes = req.user.pincodes;
    if (!myPincodes || myPincodes.length === 0) {
      return res.json([]);
    }

    const availableJobs = await DeliveryAssignment.find({
      deliveryBoy: null,
      status: 'Pending',
      pincode: { $in: myPincodes }
    })
    .populate({
      path: 'order',
      select: 'orderItems shippingAddress totalAmount paymentMethod seller user shippingFee discountAmount taxAmount',
      populate: [
        { path: 'seller', select: 'name pickupAddress' },
        { path: 'user', select: 'name' }
      ]
    })
    .sort({ createdAt: 1 });

    res.json(availableJobs);
  } catch (err) {
    console.error('Error fetching available orders:', err.message);
    res.status(500).json({ message: 'Error fetching available orders', error: err.message });
  }
});

app.get('/api/delivery/my-orders', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const myJobs = await DeliveryAssignment.find({
      deliveryBoy: req.user._id,
      status: { $in: ['Accepted', 'PickedUp'] }
    })
    .populate({
      path: 'order',
      select: 'orderItems shippingAddress totalAmount paymentMethod seller user shippingFee discountAmount taxAmount',
      populate: [
        { path: 'seller', select: 'name pickupAddress' },
        { path: 'user', select: 'name phone' }
      ]
    })
    .sort({ updatedAt: -1 });

    res.json(myJobs);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching my orders', error: err.message });
  }
});

app.put('/api/delivery/assignments/:id/accept', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const assignment = await DeliveryAssignment.findOneAndUpdate(
      {
        _id: assignmentId,
        status: 'Pending',
        deliveryBoy: null
      },
      {
        $set: {
          deliveryBoy: req.user._id,
          status: 'Accepted'
        },
        $push: { history: { status: 'Accepted' } }
      },
      { new: true }
    ).populate({
        path: 'order',
        select: 'seller user',
        populate: [
          { path: 'seller', select: 'name phone fcmToken' },
          { path: 'user', select: 'name phone fcmToken' }
        ]
    });

    if (!assignment) {
      return res.status(409).json({ message: 'This order has just been accepted by someone else.' });
    }

    const orderIdShort = assignment.order._id.toString().slice(-6);

    const seller = assignment.order.seller;
    if (seller) {
      await sendWhatsApp(seller.phone, `Order Update: Delivery boy ${req.user.name} is on the way to pick up order #${orderIdShort}.`);
      await sendPushNotification(
        seller.fcmToken,
        'Delivery Boy Assigned',
        `${req.user.name} is picking up order #${orderIdShort}.`,
        { orderId: assignment.order._id.toString(), type: 'DELIVERY_ASSIGNED' }
      );
    }
    
    const customer = assignment.order.user;
    if (customer) {
        await sendWhatsApp(customer.phone, `Your order #${orderIdShort} is being prepared! Delivery partner ${req.user.name} will pick it up soon.`);
        await sendPushNotification(
          customer.fcmToken,
          'Order Update!',
          `Delivery partner ${req.user.name} has accepted your order #${orderIdShort}.`,
          { orderId: assignment.order._id.toString(), type: 'ORDER_STATUS' }
        );
    }

    res.json({ message: 'Order accepted successfully!', assignment });

  } catch (err) {
    console.error('Error accepting order:', err.message);
    res.status(500).json({ message: 'Error accepting order', error: err.message });
  }
});

app.put('/api/delivery/assignments/:id/status', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const { status } = req.body;
    const assignmentId = req.params.id;

    if (!['PickedUp', 'Delivered', 'Cancelled'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be PickedUp, Delivered, or Cancelled.' });
    }

    const assignment = await DeliveryAssignment.findOne({
      _id: assignmentId,
      deliveryBoy: req.user._id
    });

    if (!assignment) {
      return res.status(404).json({ message: 'Delivery assignment not found or you are not authorized.' });
    }

    let newOrderStatus = '';
    let newAssignmentStatus = '';
    let notificationTitle = '';
    let notificationBody = '';

    if (status === 'PickedUp' && assignment.status === 'Accepted') {
      newAssignmentStatus = 'PickedUp';
      newOrderStatus = 'Shipped';
      notificationTitle = 'Order Picked Up!';
      notificationBody = `Your order (#${assignment.order.toString().slice(-6)}) is on its way!`;

    } else if (status === 'Delivered' && assignment.status === 'PickedUp') {
      newAssignmentStatus = 'Delivered';
      newOrderStatus = 'Delivered';
      notificationTitle = 'Order Delivered! 🎉';
      notificationBody = `Your order (#${assignment.order.toString().slice(-6)}) has been successfully delivered. Thank you!`;

    } else if (status === 'Cancelled') {
        newAssignmentStatus = 'Cancelled';
        newOrderStatus = 'Cancelled';
        notificationTitle = 'Order Cancelled';
        notificationBody = `We're sorry, but your order (#${assignment.order.toString().slice(-6)}) has been cancelled.`;

    } else {
      return res.status(400).json({ message: `Invalid status transition from ${assignment.status} to ${status}.` });
    }

    
    assignment.status = newAssignmentStatus;
    assignment.history.push({ status: newAssignmentStatus });
    await assignment.save();

    const order = await Order.findById(assignment.order);
    if (!order) {
        return res.status(404).json({ message: 'Associated order not found.' });
    }

    order.deliveryStatus = newOrderStatus;
    order.history.push({ status: newOrderStatus, note: `Updated by Delivery Boy ${req.user.name}` });

    if (newOrderStatus === 'Delivered' && (order.paymentMethod === 'cod' || order.paymentMethod === 'razorpay_cod') && order.paymentStatus === 'pending') {
      order.paymentStatus = 'completed';
    }

    if (newOrderStatus === 'Cancelled') {
        if (order.paymentStatus !== 'failed' && order.deliveryStatus !== 'Payment Pending') {
             for(const item of order.orderItems) {
                await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
            }
        }
        
        if (order.paymentMethod === 'razorpay' && order.paymentStatus === 'completed') {
            await notifyAdmin(`Admin Alert: Order #${order._id} was CANCELLED by delivery boy after pickup. Please check for a manual refund.`);
        }
    }

    await order.save();

    const customer = await User.findById(order.user).select('phone fcmToken');
    if (customer) {
        const orderIdShort = order._id.toString().slice(-6);
        await sendWhatsApp(customer.phone, `${notificationTitle}\n${notificationBody}`);
        await sendPushNotification(
            customer.fcmToken,
            notificationTitle,
            notificationBody,
            { orderId: order._id.toString(), type: 'ORDER_STATUS' }
        );
    }
    
    res.json({ message: `Order status updated to ${newAssignmentStatus}`, assignment });

  } catch (err) {
    console.error('Error updating order status:', err.message);
    res.status(500).json({ message: 'Error updating order status', error: err.message });
  }
});

app.get('/api/delivery/my-history', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate query parameters are required.' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    const historyJobs = await DeliveryAssignment.find({
      deliveryBoy: req.user._id,
      status: 'Delivered',
      updatedAt: {
        $gte: start,
        $lte: end
      }
    })
    .populate({
      path: 'order',
      select: 'orderItems totalAmount paymentMethod paymentStatus shippingFee discountAmount taxAmount',
    })
    .sort({ updatedAt: -1 });

    res.json(historyJobs);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching delivery history', error: err.message });
  }
});

app.post('/api/delivery/orders/:id/generate-payment-link', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const orderId = req.params.id;
    const assignment = await DeliveryAssignment.findOne({ 
      order: orderId, 
      deliveryBoy: req.user._id 
    });

    if (!assignment) {
      return res.status(404).json({ message: 'No delivery assignment found for this order under your name.' });
    }

    const order = await Order.findById(orderId).populate('user', 'name phone');
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }
    if (order.paymentMethod !== 'cod') {
      return res.status(400).json({ message: 'This order is not a Cash on Delivery order.' });
    }
    if (order.paymentStatus === 'completed') {
      return res.status(400).json({ message: 'This order has already been paid for.' });
    }

    if (order.razorpayPaymentLinkId) {
      try {
        const existingLink = await razorpay.paymentLink.fetch(order.razorpayPaymentLinkId);
        if (existingLink.status === 'created' || existingLink.status === 'pending') {
          const qrCodeDataUrl = await qrcode.toDataURL(existingLink.short_url);
          return res.json({ 
            message: 'Existing payment link retrieved.',
            shortUrl: existingLink.short_url, 
            qrCodeDataUrl,
            paymentLinkId: existingLink.id
          });
        }
      } catch (fetchErr) {
        console.log('Could not fetch existing payment link, creating a new one.');
      }
    }
    const amountToCollect = (order.totalAmount + order.shippingFee + order.taxAmount - order.discountAmount);
    const orderIdShort = order._id.toString().slice(-6);

    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(amountToCollect * 100),
      currency: "INR",
      accept_partial: false,
      description: `Payment for Order #${orderIdShort}`,
      customer: {
        name: order.user.name || 'Valued Customer',
        phone: order.user.phone,
      },
      notify: {
        sms: true,
        email: false
      },
      reminder_enable: false,
      notes: {
        order_id: order._id.toString(),
        delivery_boy_id: req.user._id.toString()
      }
    });

    order.razorpayPaymentLinkId = paymentLink.id;
    await order.save();

    const qrCodeDataUrl = await qrcode.toDataURL(paymentLink.short_url);

    res.status(201).json({
      message: 'Payment link generated successfully.',
      shortUrl: paymentLink.short_url,
      qrCodeDataUrl,
      paymentLinkId: paymentLink.id
    });

  } catch (err) {
    console.error('Error generating payment link:', err.message);
    res.status(500).json({ message: 'Error generating payment link', error: err.message });
  }
});

app.get('/api/delivery/order-payment-status/:id', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const orderId = req.params.id;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    const assignment = await DeliveryAssignment.findOne({ order: orderId, deliveryBoy: req.user._id });
    if (!assignment) {
        return res.status(403).json({ message: 'Access denied. You are not assigned to this order.' });
    }

    if (order.paymentStatus === 'completed') {
      return res.json({ paymentStatus: 'completed' });
    }

    if (!order.razorpayPaymentLinkId) {
      return res.json({ paymentStatus: 'pending' });
    }

    const paymentLink = await razorpay.paymentLink.fetch(order.razorpayPaymentLinkId);

    if (paymentLink.status === 'paid') {
      order.paymentStatus = 'completed';
      order.paymentMethod = 'razorpay_cod';
      
      if (paymentLink.payments && paymentLink.payments.length > 0) {
        order.paymentId = paymentLink.payments[0].payment_id;
      }
      await order.save();
      return res.json({ paymentStatus: 'completed' });
    }

    return res.json({ paymentStatus: 'pending' });

  } catch (err) {
    console.error('Error checking payment status:', err.message);
    res.status(500).json({ message: 'Error checking payment status', error: err.message });
  }
});

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
      const idsToDelete = Array.isArray(imagesToDelete) ? idsToDelete : [imagesToDelete];
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

app.get('/api/admin/delivery-boys', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const deliveryBoys = await User.find({ role: 'delivery' }).select('-password');
    res.json(deliveryBoys);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching delivery boys' });
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
      filter.deliveryStatus = { $ne: 'Payment Pending' };
      filter.paymentStatus = { $ne: 'failed' };
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
    
    
    if (status === 'Cancelled') {
        try {
            const assignment = await DeliveryAssignment.findOneAndUpdate(
              { order: order._id },
              { $set: { status: 'Cancelled' }, $push: { history: { status: 'Cancelled' } } },
              { new: true }
            ).populate('deliveryBoy', 'fcmToken');
            
            
            if (assignment && assignment.deliveryBoy && assignment.status !== 'Pending') {
                await sendPushNotification(
                    assignment.deliveryBoy.fcmToken,
                    'Order Cancelled',
                    `Order #${order._id.toString().slice(-6)} has been cancelled by the ${req.user.role}.`,
                    { orderId: order._id.toString(), type: 'ORDER_CANCELLED' }
                );
            }

            if (order.paymentStatus !== 'failed' && order.deliveryStatus !== 'Payment Pending') {
                for(const item of order.orderItems) {
                    await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
                }
            }

        } catch(assignErr) {
            console.error("Error updating assignment on admin cancel:", assignErr.message);
        }
    }
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
// ✅ UPDATED: This route now handles a file upload named 'media'
app.post('/api/admin/broadcast', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
  try {
    const { title, message, target } = req.body;
    
    if (!title || !message || !target) { 
      return res.status(400).json({ message: 'Title, message, and target audience are required.' });
    }

    // Check if a file was uploaded and get its URL from Cloudinary
    const imageUrl = req.file ? req.file.path : null;

    let query = {};
    if (target === 'users') {
      query = { role: 'user' };
    } else if (target === 'sellers') {
      query = { role: 'seller', approved: true };
    } else if (target === 'delivery_boys') {
      query = { role: 'delivery', approved: true };
    } else if (target !== 'all') {
      return res.status(400).json({ message: "Invalid target." });
    }

    const recipients = await User.find(query).select('phone fcmToken');
    
    let successCount = 0;
    const fcmTokens = [];

    for (const recipient of recipients) {
      // WhatsApp does not support images in this simple way, so we only send text.
      if (recipient.phone) {
        await sendWhatsApp(recipient.phone, `*${title}*\n\n${message}`);
        successCount++;
      }
      if (recipient.fcmToken) {
        fcmTokens.push(recipient.fcmToken);
      }
    }

    if (fcmTokens.length > 0) {
      await sendPushNotification(
        fcmTokens, 
        title, 
        message, 
        { type: 'BROADCAST' },
        imageUrl // Use the uploaded image URL here
      );
    }

    res.json({ message: `Broadcast sent successfully to ${fcmTokens.length} devices.` });

  } catch (err) {
    console.error('Broadcast error:', err.message);
    res.status(500).json({ message: 'Error sending broadcast message', error: err.message });
  }
});
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
    console.status(500).json({ message: 'Error deleting banner', error: err.message });
  }
});

// --------------------------------------------------------------------------------
// --------- ADMIN SPLASH SCREEN ROUTES ----------
// --------------------------------------------------------------------------------

// GET all splash screens for the admin panel
app.get('/api/admin/splash', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const splashes = await Splash.find().sort({ createdAt: -1 });
    res.json(splashes);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching splash screens', error: err.message });
  }
});

// POST a new splash screen
app.post('/api/admin/splash', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
  try {
    const { title, link, type = 'default', isActive = 'true', startDate, endDate } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: 'An image or video file is required.' });
    }

    const newSplash = await Splash.create({
      title,
      link,
      type,
      isActive: isActive === 'true',
      startDate: type === 'scheduled' ? startDate : null,
      endDate: type === 'scheduled' ? endDate : null,
      image: {
        url: file.path,
        publicId: file.filename
      }
    });

    res.status(201).json(newSplash);
  } catch (err) {
    console.error('Create splash screen error:', err.message);
    res.status(500).json({ message: 'Error creating splash screen', error: err.message });
  }
});

// PUT (edit) an existing splash screen
app.put('/api/admin/splash/:id', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
  try {
    const { title, link, type, isActive, startDate, endDate } = req.body;
    const splash = await Splash.findById(req.params.id);

    if (!splash) {
      return res.status(404).json({ message: 'Splash screen not found.' });
    }

    if (req.file) {
      // Delete old image from Cloudinary if it exists
      if (splash.image && splash.image.publicId) {
        await cloudinary.uploader.destroy(splash.image.publicId);
      }
      splash.image = { url: req.file.path, publicId: req.file.filename };
    }
    
    if (title) splash.title = title;
    if (link) splash.link = link;
    if (type) splash.type = type;
    if (typeof isActive !== 'undefined') splash.isActive = isActive === 'true';
    splash.startDate = type === 'scheduled' ? startDate : null;
    splash.endDate = type === 'scheduled' ? endDate : null;

    await splash.save();
    res.json(splash);
  } catch (err) {
    res.status(500).json({ message: 'Error updating splash screen', error: err.message });
  }
});

// DELETE a splash screen
app.delete('/api/admin/splash/:id', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const splash = await Splash.findById(req.params.id);
    if (!splash) {
      return res.status(404).json({ message: 'Splash screen not found.' });
    }

    // Delete image from Cloudinary
    if (splash.image && splash.image.publicId) {
      await cloudinary.uploader.destroy(splash.image.publicId);
    }

    await splash.deleteOne();
    res.json({ message: 'Splash screen deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting splash screen', error: err.message });
  }
});

// REPLACE your old /api/splash route with this one
app.get('/api/splash', async (req, res) => {
  try {
    const now = new Date();
    let activeSplash = null;

    // 1. Look for an active, scheduled splash screen for the current date
    const scheduledSplash = await Splash.findOne({
      isActive: true,
      type: 'scheduled',
      startDate: { $lte: now },
      endDate: { $gte: now }
    });

    if (scheduledSplash) {
      activeSplash = scheduledSplash;
    } else {
      // 2. If no scheduled splash is active, find the default one
      const defaultSplash = await Splash.findOne({
        isActive: true,
        type: 'default'
      });
      activeSplash = defaultSplash;
    }

    // Return the single active splash screen (or null if none found)
    res.json({ splash: activeSplash });

  } catch (err) {
    console.error('Error fetching splash screen for app:', err.message);
    res.status(500).json({ message: 'Error fetching splash screen' });
  }
});
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

app.get('/api/admin/reports/sales', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const salesReport = await Order.aggregate([
      { $match: { deliveryStatus: 'Delivered', paymentStatus: 'completed' } },
      { $group: { 
        _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, 
        totalSales: { $sum: { $add: ["$totalAmount", "$shippingFee", "$taxAmount", { $multiply: ["$discountAmount", -1] }] } },
        totalOrders: { $sum: 1 } 
      }},
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
          totalTax: { $sum: '$taxAmount' },
          totalShipping: { $sum: '$shippingFee' },
          totalDiscount: { $sum: '$discountAmount' },
          totalRefunds: { $sum: '$totalRefunded' },
          totalOrders: { $sum: 1 }
        }
      }
    ]);
    
    const appSettings = await AppSettings.findOne({ singleton: true });
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;

    const summary = salesSummary.length > 0 ? salesSummary[0] : { totalSales: 0, totalTax: 0, totalShipping: 0, totalDiscount: 0, totalRefunds: 0, totalOrders: 0 };
    
    const grossRevenue = summary.totalSales + summary.totalTax + summary.totalShipping - summary.totalDiscount;
    const platformEarnings = summary.totalSales * PLATFORM_COMMISSION_RATE;
    const netRevenue = grossRevenue - summary.totalRefunds;

    res.json({
      totalSales: summary.totalSales,
      totalTax: summary.totalTax,
      totalShipping: summary.totalShipping,
      totalDiscount: summary.totalDiscount,
      totalOrders: summary.totalOrders,
      grossRevenue: grossRevenue,
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

      Order.aggregate([
        { $group: { _id: "$deliveryStatus", count: { $sum: 1 } } }
      ]),

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

      Order.aggregate([
        { $match: { deliveryStatus: 'Delivered' } },
        { $group: {
          _id: "$user",
          totalSpent: { $sum: '$totalAmount' }
        }},
        { $sort: { totalSpent: -1 } },
        { $limit: 5 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userInfo' } },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
        { $project: { name: { $ifNull: [ "$userInfo.name", "Deleted User" ] }, totalSpent: 1 } }
      ]),

      Order.aggregate([
        { $match: { paymentStatus: 'completed', deliveryStatus: { $ne: 'Cancelled' } } },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$totalAmount' },
            totalTax: { $sum: '$taxAmount' },
            totalShipping: { $sum: '$shippingFee' },
            totalDiscount: { $sum: '$discountAmount' },
            totalRefunds: { $sum: '$totalRefunded' }
          }
        }
      ]),

      Order.aggregate([
        { $match: { paymentStatus: 'completed' } },
        { $group: { _id: "$paymentMethod", count: { $sum: 1 } } }
      ]),

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

    const financials = financialSummaryData[0] || { totalSales: 0, totalTax: 0, totalShipping: 0, totalDiscount: 0, totalRefunds: 0 };
    
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;
    const grossRevenue = financials.totalSales + financials.totalTax + financials.totalShipping - financials.totalDiscount;
    const platformEarnings = financials.totalSales * PLATFORM_COMMISSION_RATE;
    const netRevenue = grossRevenue - financials.totalRefunds;

    res.json({
      orderStats: orderStatsFormatted,
      paymentMethodStats: paymentStatsFormatted,
      topProducts: topSellingProducts,
      topSellers: topSellingSellers,
      topCustomers: topCustomers,
      financials: {
        totalSales: financials.totalSales,
        totalTax: financials.totalTax,
        totalShipping: financials.totalShipping,
        totalDiscount: financials.totalDiscount,
        totalRefunds: financials.totalRefunds,
        grossRevenue: grossRevenue,
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

    if ((order.paymentMethod !== 'razorpay' && order.paymentMethod !== 'razorpay_cod') || order.paymentStatus !== 'completed') {
      return res.status(400).json({ message: 'Refunds are only available for completed Razorpay payments.' });
    }
    
    const paymentId = order.paymentId;
    if (!paymentId.startsWith('pay_') && !paymentId.startsWith('plink_')) {
      return res.status(400).json({ message: 'Invalid payment ID associated with this order. Cannot refund.' });
    }

    const orderGrandTotal = (order.totalAmount + order.shippingFee + order.taxAmount) - order.discountAmount;
    const refundableAmount = orderGrandTotal - order.totalRefunded;
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
    
    if (order.totalRefunded >= orderGrandTotal) {
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
app.post('/api/admin/notifications/schedule', protect, authorizeRole('admin'), upload.single('image'), async (req, res) => {
  try {
    const { title, body, target, scheduledAt } = req.body;

    if (!title || !body || !target || !scheduledAt) {
      return res.status(400).json({ message: 'Title, message, scheduled time, and target audience are required.' });
    }

    const scheduledDate = new Date(scheduledAt);
    if (isNaN(scheduledDate.getTime()) || scheduledDate < new Date()) {
      return res.status(400).json({ message: 'Invalid or past scheduled date.' });
    }

    let imageUrl = null;

    // ✅ Upload to Cloudinary (if image file provided)
    if (req.file) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: 'notifications'
      });
      imageUrl = uploadResult.secure_url;
      console.log('✅ Image uploaded:', imageUrl);
    }

    // ✅ Save notification data in DB
    const newNotification = await ScheduledNotification.create({
      title,
      body,
      target,
      scheduledAt: scheduledDate,
      imageUrl
    });

    res.status(201).json({
      message: 'Notification scheduled successfully.',
      notification: newNotification
    });

  } catch (err) {
    console.error('❌ Schedule notification error:', err.message);
    res.status(500).json({
      message: 'Error scheduling notification.',
      error: err.message
    });
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
      } else if (notification.target === 'delivery_boys') {
        query = { role: 'delivery', approved: true };
      } else if (notification.target !== 'all') {
        continue;
      }

      const recipients = await User.find(query).select('fcmToken');
      const fcmTokens = recipients.map(r => r.fcmToken).filter(Boolean);

      if (fcmTokens.length > 0) {
        
        await sendPushNotification(
          fcmTokens, 
          notification.title, 
          notification.body,
          { type: 'BROADCAST' },
          notification.imageUrl
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

cron.schedule('0 3 * * *', async () => {
  console.log('Running Abandoned Cart Reminder check...');
  
  const cutoffDate = new Date(Date.now() - 48 * 60 * 60 * 1000); 

  try {
    const abandonedCarts = await Cart.find({
      updatedAt: { $lt: cutoffDate },
      'items.0': { '$exists': true }
    }).populate('user', 'name fcmToken');

    for (const cart of abandonedCarts) {
      const user = cart.user;
      
      if (user && user.fcmToken) {
        const itemCount = cart.items.length;
        const messageBody = itemCount === 1 
          ? `You left 1 item in your bag! Don't miss out, complete your order now! 🛒`
          : `You have ${itemCount} items waiting! Complete your purchase before they sell out! 💨`;

        await sendPushNotification(
          user.fcmToken,
          'Don\'t Forget Your Cart! 🎉', 
          messageBody,
          { type: 'CART_REMINDER' }
        );
        console.log(`Sent cart reminder to user: ${user.name}`);
        
        
        await Cart.updateOne({ _id: cart._id }, { $set: { updatedAt: new Date() } });
      }
    }
    console.log(`Abandoned Cart check finished. ${abandonedCarts.length} reminders sent.`);

  } catch (err) {
    console.error('Abandoned Cart Cron Job Failed:', err.message);
  }
});

app.get('/', (req, res) => {
  res.send('E-Commerce Backend API is running!');
});
// --------------------------------------------------------------------------------
// --------- ADMIN COUPON ROUTES ----------
// --------------------------------------------------------------------------------

// GET all coupons (Admin only)
app.get('/api/admin/coupons', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ expiryDate: -1 });
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching coupons', error: err.message });
  }
});

// POST to create a new coupon (Admin only)
app.post('/api/admin/coupons', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { 
      code, 
      discountType, 
      discountValue, 
      minPurchaseAmount, 
      maxDiscountAmount, 
      expiryDate 
    } = req.body;

    if (!code || !discountType || !discountValue || !expiryDate) {
      return res.status(400).json({ message: 'Code, discount type, value, and expiry date are required.' });
    }

    const newCoupon = await Coupon.create({
      code: code.toUpperCase(),
      discountType,
      discountValue,
      minPurchaseAmount,
      maxDiscountAmount,
      expiryDate
    });

    res.status(201).json(newCoupon);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: `Coupon code "${req.body.code}" already exists.` });
    }
    res.status(500).json({ message: 'Error creating coupon', error: err.message });
  }
});

// PUT to update an existing coupon (Admin only)
app.put('/api/admin/coupons/:id', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { 
      discountType, 
      discountValue, 
      minPurchaseAmount, 
      maxDiscountAmount, 
      expiryDate,
      isActive
    } = req.body;

    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found.' });
    }

    // Update fields if they are provided
    if (discountType) coupon.discountType = discountType;
    if (discountValue) coupon.discountValue = discountValue;
    if (minPurchaseAmount) coupon.minPurchaseAmount = minPurchaseAmount;
    if (maxDiscountAmount) coupon.maxDiscountAmount = maxDiscountAmount;
    if (expiryDate) coupon.expiryDate = expiryDate;
    if (typeof isActive !== 'undefined') coupon.isActive = isActive;

    await coupon.save();
    res.json(coupon);
  } catch (err) {
    res.status(500).json({ message: 'Error updating coupon', error: err.message });
  }
});

// DELETE a coupon (Admin only)
app.delete('/api/admin/coupons/:id', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);

    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found.' });
    }

    res.json({ message: 'Coupon deleted successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting coupon', error: err.message });
  }
});
// --------------------------------------------------------------------------------
// --------- COUPON ROUTES (FOR USERS) ----------
// --------------------------------------------------------------------------------

// GET all active and valid coupons
app.get('/api/coupons', protect, async (req, res) => {
  try {
    const now = new Date();
    
    // Find coupons that are active and not expired
    const availableCoupons = await Coupon.find({
      isActive: true,
      expiryDate: { $gt: now } 
    }).sort({ minPurchaseAmount: 1 }); // Sort by minimum purchase amount

    res.json(availableCoupons);
  } catch (err) {
    console.error('Error fetching available coupons:', err.message);
    res.status(500).json({ message: 'Error fetching coupons' });
  }
});
// In server.js, add this new route (e.g., after the admin broadcast route)

app.get('/api/notifications/history', protect, async (req, res) => {
    try {
        const userRole = req.user.role; // 'user', 'seller', etc.
        
        // Find notifications that were sent and targeted 'all' or the user's specific role
        const notifications = await ScheduledNotification.find({
            isSent: true,
            target: { $in: ['all', userRole] }
        })
        .sort({ sentAt: -1 }) // Show newest first
        .limit(50); // Limit to the last 50 notifications

        res.json(notifications);

    } catch (err) {
        console.error('Error fetching notification history:', err.message);
        res.status(500).json({ message: 'Error fetching notification history' });
    }
});

app.post('/api/orders/buy-now-summary', protect, async (req, res) => {
    try {
        const { productId, qty = 1, shippingAddressId, couponCode } = req.body;

        if (!productId || !shippingAddressId) {
            return res.status(400).json({ message: 'Product ID and Address ID are required.' });
        }

        const product = await Product.findById(productId).populate('seller', 'pincodes');
        const shippingAddress = await Address.findById(shippingAddressId);

        if (!product) return res.status(404).json({ message: 'Product not found.' });
        if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found.' });
        if (product.stock < qty) return res.status(400).json({ message: `Insufficient stock for ${product.name}` });
        if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
            return res.status(400).json({ message: `Delivery not available for ${product.name} at your location.` });
        }

        const itemsTotal = product.price * qty;
        let discountAmount = 0;
        const shippingFee = calculateShippingFee(shippingAddress.pincode);
        const taxAmount = itemsTotal * GST_RATE;

        // Coupon Logic (same as cart)
        if (couponCode) {
            const coupon = await Coupon.findOne({
                code: couponCode,
                isActive: true,
                expiryDate: { $gt: new Date() },
                minPurchaseAmount: { $lte: itemsTotal }
            });
            if (coupon) {
                if (coupon.discountType === 'percentage') {
                    discountAmount = itemsTotal * (coupon.discountValue / 100);
                    if (coupon.maxDiscountAmount && discountAmount > coupon.maxDiscountAmount) {
                        discountAmount = coupon.maxDiscountAmount;
                    }
                } else if (coupon.discountType === 'fixed') {
                    discountAmount = coupon.discountValue;
                }
            }
        }

        const grandTotal = Math.max(0, itemsTotal + shippingFee + taxAmount - discountAmount);

        res.json({
            itemsTotal,
            totalShippingFee: shippingFee,
            totalTaxAmount: taxAmount,
            totalDiscount: discountAmount,
            grandTotal,
        });

    } catch (err) {
        res.status(500).json({ message: 'Error calculating Buy Now summary', error: err.message });
    }
});


// ✅ NEW: Endpoint to place an order for a single "Buy Now" item
app.post('/api/orders/buy-now', protect, async (req, res) => {
    // 1. Change the input from productId to variantId
    const { variantId, qty = 1, shippingAddressId, paymentMethod, couponCode } = req.body;

    // We'll use a transaction for atomicity, which is crucial for stock management
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 2. Lookup the Variant and populate its parent Product and Seller
        const variant = await Variant.findById(variantId)
            .populate('product') // Populate the parent product
            .session(session); // Use session for consistent reads

        if (!variant || !variant.product) {
            await session.abortTransaction();
            return res.status(404).json({ message: 'Product variant not found.' });
        }

        // Assign to product/seller for cleaner code, consistent with original logic
        const product = variant.product;
        // Since we need seller info (pincodes), we need another lookup or to populate deeper
        const seller = await User.findById(product.seller).select('pincodes name phone fcmToken').session(session);

        const shippingAddress = await Address.findById(shippingAddressId).session(session);

        // Validations
        if (!shippingAddress) {
            await session.abortTransaction();
            return res.status(404).json({ message: 'Shipping address not found.' });
        }
        
        // Stock check now uses variant.stock
        if (variant.stock < qty) {
            await session.abortTransaction();
            return res.status(400).json({ message: `Insufficient stock for ${product.name} (Variant: ${variant.color}, ${variant.size})` });
        }
        
        // Pincode check uses the fetched seller object
        if (!seller.pincodes.includes(shippingAddress.pincode)) {
             await session.abortTransaction();
             return res.status(400).json({ message: `Delivery not available for ${product.name} at your location.` });
        }
        
        // Calculations now use variant.price
        const itemsTotal = variant.price * qty;
        let discountAmount = 0;
        const shippingFee = calculateShippingFee(shippingAddress.pincode);
        const taxAmount = itemsTotal * GST_RATE;

        // ... (Coupon Logic remains here)
        
        let finalAmountForPayment = Math.max(0, itemsTotal + shippingFee + taxAmount - discountAmount);
        
        let effectivePaymentMethod = paymentMethod;
        if (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) {
            effectivePaymentMethod = 'cod';
        }

        let razorpayOrder = null;
        if (effectivePaymentMethod === 'razorpay') {
            razorpayOrder = await razorpay.orders.create({
                amount: Math.round(finalAmountForPayment * 100),
                currency: 'INR',
                receipt: `rcpt_buynow_${crypto.randomBytes(4).toString('hex')}`,
            });
        }
        
        const isCodOrFree = effectivePaymentMethod === 'cod' || finalAmountForPayment === 0;

        const order = new Order({
            user: req.user._id,
            seller: seller._id, // Use the fetched seller
            orderItems: [{
                product: product._id,
                name: product.name,
                qty: qty,
                price: variant.price, // Use variant's price
                originalPrice: product.originalPrice,
                category: product.category,
                // 4. SAVE COLOR AND SIZE ATTRIBUTES HERE!
                variantId: variant._id, 
                color: variant.color,
                size: variant.size,
                // Assuming variant has a 'sku' field
                sku: variant.sku, 
            }],
            shippingAddress: `${shippingAddress.street}, ${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}`,
            pincode: shippingAddress.pincode,
            paymentMethod: effectivePaymentMethod,
            totalAmount: itemsTotal,
            taxAmount,
            couponApplied: couponCode,
            discountAmount,
            shippingFee,
            paymentId: razorpayOrder ? razorpayOrder.id : (isCodOrFree ? `cod_${crypto.randomBytes(8).toString('hex')}` : undefined),
            paymentStatus: isCodOrFree ? 'completed' : 'pending',
            deliveryStatus: isCodOrFree ? 'Pending' : 'Payment Pending',
            history: [{ status: isCodOrFree ? 'Pending' : 'Payment Pending' }]
        });
        
        await order.save({ session }); // Save the order within the transaction

        if (isCodOrFree) {
            // 3. Atomically decrement stock on the Variant model
            const updatedVariant = await Variant.findOneAndUpdate(
                { _id: variant._id, stock: { $gte: qty } },
                { $inc: { stock: -qty } },
                { new: true, session }
            );
            
            if (!updatedVariant) {
                await session.abortTransaction();
                return res.status(409).json({ message: `Concurrency error: Insufficient stock for ${product.name}. Please try again.` });
            }
            // Send notifications, etc.
        }

        await session.commitTransaction(); // Commit all changes if successful
        session.endSession();

        res.status(201).json({
            message: effectivePaymentMethod === 'razorpay' ? 'Order initiated, awaiting payment.' : 'Order created successfully.',
            orders: [order._id],
            razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount, key_id: process.env.RAZORPAY_KEY_ID } : undefined,
        });

    } catch (err) {
        if (session.inTransaction()) {
            await session.abortTransaction(); // Rollback on error
        }
        session.endSession();
        res.status(500).json({ message: 'Error placing Buy Now order', error: err.message });
    }
});

// [NEW] API Endpoint for a customer to initiate a return request
app.post('/api/orders/:id/return-request', protect, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || reason.trim().length < 10) {
            return res.status(400).json({ 
                message: 'A valid reason for the return/refund is required (min 10 characters).' 
            });
        }

        const order = await Order.findOne({ 
            _id: req.params.id, 
            user: req.user._id 
        }).populate('seller', 'name email phone');
        
        if (!order) {
            return res.status(404).json({ 
                message: 'Order not found or you do not have permission.' 
            });
        }

        const isDelivered = order.deliveryStatus === 'Delivered';
        const isRefunded = order.paymentStatus === 'refunded';
        
        if (!isDelivered || isRefunded || order.deliveryStatus === 'Cancelled') {
            return res.status(400).json({ 
                message: `Cannot request a return. Current status: ${order.deliveryStatus}.` 
            });
        }
        
        // 💡 ENFORCE 2-DAY (48-HOUR) RETURN WINDOW
        const twoDaysInMs = 2 * 24 * 60 * 60 * 1000;
        const timeSinceDelivery = Date.now() - order.updatedAt.getTime(); 

        if (timeSinceDelivery > twoDaysInMs) {
            return res.status(400).json({ 
                message: 'Return window expired. Returns must be requested within 48 hours of delivery.' 
            });
        }

        const hoursLeft = Math.floor((twoDaysInMs - timeSinceDelivery) / (1000 * 60 * 60));
        const minutesLeft = Math.floor(((twoDaysInMs - timeSinceDelivery) % (1000 * 60 * 60)) / (1000 * 60));

        // 2. Check if a refund/return is already requested
        const alreadyRequested = order.refunds.some(r => r.status === 'requested' || r.status === 'processing');
        if (alreadyRequested) {
            return res.status(400).json({ 
                message: 'A return or refund is already pending for this order.' 
            });
        }

        // 3. Create a new refund/return request entry
        order.refunds.push({
            amount: 0, // Admin will set the actual amount to refund later
            reason: reason,
            status: 'requested',
            processedBy: req.user._id,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        
        // Update the order status to reflect the request
        order.deliveryStatus = 'Return Requested'; 
        order.history.push({ status: 'Return Requested', note: `Reason: ${reason}` });

        await order.save();
        
        // 4. Notify Admin
        await notifyAdmin(`🔔 New Return Request for Order #${order._id.toString().slice(-6)}\n\nUser: ${req.user.name}\nReason: ${reason}`);

        res.json({ 
            message: `Return request successfully submitted. Returns are allowed within 48 hours of delivery. You have ${hoursLeft} hours and ${minutesLeft} minutes left in your return window. The admin will review your request shortly.`, 
            order 
        });

    } catch (err) {
        console.error('Return request error:', err.message);
        res.status(500).json({ 
            message: 'Error submitting return request', 
            error: err.message 
        });
    }
});

// Seller payout request
// POST /api/seller/payouts/request (Modified)

// POST /api/seller/payouts/request (Modified for Manual Payouts)

app.post('/api/seller/payouts/request', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const sellerId = req.user._id;
        const { amount } = req.body; // अब upiId को body से लेने की ज़रूरत नहीं है

        const amountFloat = parseFloat(amount);
        if (isNaN(amountFloat) || amountFloat <= 0 || amountFloat < 100) {
             return res.status(400).json({ message: 'Invalid or insufficient payout amount (Min ₹100).' });
        }

        // 1. Get current balance using the helper
        const financials = await calculateSellerFinancials(sellerId);

        if (amountFloat > financials.availableBalance) { 
            return res.status(400).json({ message: 'Insufficient available balance.' });
        }

        // 2. CRITICAL CHECK: Ensure bank details are present for manual transfer
        const payoutDetails = req.user.payoutDetails;
        if (!payoutDetails || (!payoutDetails.bankAccountNumber && !payoutDetails.vpa)) {
            return res.status(400).json({ message: 'Bank details not set. Please add your payout account details first.' });
        }

        // 3. Create Payout record in your DB (status: pending)
        const payout = await Payout.create({
            seller: sellerId,
            amount: amountFloat,
            status: 'pending',
            notes: `MANUAL TRANSFER: ${payoutDetails.bankAccountNumber ? `A/C: ${payoutDetails.bankAccountNumber}` : `VPA: ${payoutDetails.vpa}`}`
        });

        // 4. Notify admin for manual processing
        await notifyAdmin(
            `🚨 MANUAL PAYOUT REQUIRED 🚨\n` +
            `Seller: ${req.user.name}\n` +
            `Amount: ₹${amountFloat.toFixed(2)}\n` +
            `Details: A/C: ${payoutDetails.bankAccountNumber || 'N/A'}, IFSC: ${payoutDetails.ifsc || 'N/A'}, VPA: ${payoutDetails.vpa || 'N/A'}\n` +
            `Payout ID: ${payout._id}`
        );

        res.status(201).json({
            message: 'Payout request submitted successfully. Awaiting manual transfer by admin.',
            payout
        });

    } catch (err) {
        console.error('Manual Payout request error:', err.message);
        res.status(500).json({ message: 'Error requesting payout', error: err.message });
    }
});
// Get seller payout history
app.get('/api/seller/payouts', protect, authorizeRole('seller'), async (req, res) => {
  try {
    const payouts = await Payout.find({ seller: req.user._id })
      .sort({ createdAt: -1 });
    
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching payout history', error: err.message });
  }
});

// Get all pending payouts (Admin)
app.get('/api/admin/payouts/pending', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const payouts = await Payout.find({ status: 'pending' })
      .populate('seller', 'name email phone')
      .sort({ createdAt: 1 });
    
    res.json(payouts);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching pending payouts', error: err.message });
  }
});

// Process payout (Admin)
// Process payout (Admin) - Confirms Admin has manually transferred funds
app.put('/api/admin/payouts/:id/process', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { transactionId, notes } = req.body;
        // transactionId यहाँ वह UTR (Unique Transaction Reference) होना चाहिए जो Admin ने बैंक से ट्रांसफर करते समय प्राप्त किया था।
        
        const payout = await Payout.findById(req.params.id).populate('seller');
        if (!payout) {
            return res.status(404).json({ message: 'Payout not found' });
        }

        if (payout.status !== 'pending') {
            return res.status(400).json({ message: 'Payout already processed' });
        }
        
        if (!transactionId) {
             return res.status(400).json({ message: 'Transaction ID (UTR) is required to mark as processed.' });
        }

        // Update payout status
        payout.status = 'processed';
        payout.transactionId = transactionId;
        payout.processedAt = new Date();
        payout.notes = `${payout.notes || ''} | Processed by admin. New Note: ${notes || 'N/A'}`;
        
        await payout.save();

        // Notify seller that transfer is complete
        const sellerMessage = `✅ Your manual payout of ₹${payout.amount} has been processed! Please check your bank account/UPI. UTR: ${transactionId}`;
        await sendWhatsApp(payout.seller.phone, sellerMessage);

        if (payout.seller.fcmToken) {
            await sendPushNotification(
                payout.seller.fcmToken,
                '💰 Payout Processed!',
                `Your manual payout of ₹${payout.amount} is complete.`,
                { type: 'PAYOUT_PROCESSED', payoutId: payout._id.toString() }
            );
        }

        res.json({
            message: 'Payout processed successfully (Manually Confirmed)',
            payout
        });

    } catch (err) {
        console.error('Process payout error:', err.message);
        res.status(500).json({ message: 'Error processing payout', error: err.message });
    }
});
// HELPER FUNCTION: Calculates Seller's Net Earnings and Balances (REQUIRED for /api/seller/payouts/request to work)
async function calculateSellerFinancials(sellerId) {
    const { ObjectId } = mongoose.Types;

    // Fetch commission rate
    const appSettings = await AppSettings.findOne({ singleton: true });
    const PLATFORM_COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;

    // 1. TOTAL REVENUE (Delivered orders only)
    const totalRevenueResult = await Order.aggregate([
        {
            $match: {
                seller: new ObjectId(sellerId),
                deliveryStatus: 'Delivered',
                paymentStatus: 'completed'
            }
        },
        {
            $group: {
                _id: null,
                totalSales: { $sum: "$totalAmount" } // Item Subtotal
            }
        }
    ]);
    const totalRevenue = totalRevenueResult[0]?.totalSales || 0;

    const platformCommission = totalRevenue * PLATFORM_COMMISSION_RATE;
    const netEarnings = totalRevenue - platformCommission; // Earnings before paying out

    // 2. PROCESSED PAYOUTS (Already paid to seller)
    const totalPayoutsResult = await Payout.aggregate([
        {
            $match: {
                seller: new ObjectId(sellerId),
                status: 'processed'
            }
        },
        {
            $group: {
                _id: null,
                totalProcessed: { $sum: "$amount" }
            }
        }
    ]);
    const totalPayouts = totalPayoutsResult[0]?.totalProcessed || 0;

    // 3. PENDING PAYOUTS (Requested by seller but not yet processed)
    const pendingPayoutsResult = await Payout.aggregate([
        {
            $match: {
                seller: new ObjectId(sellerId),
                status: 'pending'
            }
        },
        {
            $group: {
                _id: null,
                totalPending: { $sum: "$amount" }
            }
        }
    ]);
    const pendingPayouts = pendingPayoutsResult[0]?.totalPending || 0;

    // 4. CALCULATE BALANCES
    const currentBalance = netEarnings - totalPayouts; // Total net earnings minus total paid out
    const availableBalance = Math.max(0, currentBalance - pendingPayouts); // Amount available for a new request

    return {
        totalRevenue: totalRevenue,
        netEarnings: netEarnings,
        platformCommission: platformCommission,
        totalPayouts: totalPayouts,
        pendingPayouts: pendingPayouts,
        currentBalance: currentBalance,
        availableBalance: availableBalance,
        commissionRate: PLATFORM_COMMISSION_RATE
    };
}

// POST /api/seller/bank-details
// Seller अपने बैंक खाते या UPI VPA को जोड़ने के लिए इस रूट का उपयोग करेगा।

// POST /api/seller/bank-details (Modified for Manual Payouts)

app.post('/api/seller/bank-details', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const { bankAccountNumber, ifsc, vpa, accountHolderName } = req.body;
        const seller = req.user;

        if ((!bankAccountNumber || !ifsc) && !vpa) {
            return res.status(400).json({ message: 'Bank Account/IFSC OR UPI VPA is required.' });
        }

        // 1. Store the details directly in the user profile
        seller.payoutDetails = {
            accountType: bankAccountNumber ? 'bank' : 'vpa',
            bankAccountNumber: bankAccountNumber || null,
            ifsc: ifsc || null,
            vpa: vpa || null,
            // (Optional) Store accountHolderName in User.name or a separate field if needed
        };
        await seller.save();

        // 2. Notify admin that new manual bank details are available
        await notifyAdmin(
            `💰 NEW Manual Payout Details Added/Updated!\n` +
            `Seller: ${seller.name} (${seller.phone})\n` +
            `A/C: ${bankAccountNumber} IFSC: ${ifsc} VPA: ${vpa}`
        );

        res.status(200).json({ 
            message: `Payout details saved successfully for manual transfer.`, 
            payoutDetails: seller.payoutDetails
        });

    } catch (err) {
        console.error('Manual Bank Details Setup Error:', err.message);
        res.status(500).json({ 
            message: 'Error saving bank details.', 
            error: err.message 
        });
    }
});
// ... (The rest of your existing order routes and other routes go here) ...


const IP = '0.0.0.0';
const PORT = process.env.PORT || 5001;

app.listen(PORT, IP, () => {
  console.log(`🚀 Server running on http://${IP}:${PORT}`);
});
