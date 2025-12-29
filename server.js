

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

const rateLimit = require('express-rate-limit');

// General limit for profile updates to prevent abuse
const profileUpdateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: 10, // Start with 10 updates per hour per IP
  message: { message: "Too many profile updates. Please try again later." }
});




// --- CONSTANTS FOR DYNAMIC DELIVERY AND TAX (UPDATED) ---
// --- DYNAMIC DELIVERY CONFIGURATION ---
const BASE_DELIVERY_KM = 2;      // पहले 2 KM तक फिक्स चार्ज
const BASE_DELIVERY_PRICE = 5;  // बेस चार्ज ₹20
const PER_KM_PRICE = 10;         // 2 KM के बाद हर KM का ₹10 एक्स्ट्रा
const GST_RATE = 0.0; 
// --------------------------------------

// --- STATIC FALLBACK CONFIGURATION (Used if GPS fails) ---
const BASE_PINCODE = '804425';   // अपना मुख्य दुकान का पिनकोड यहाँ डालें
const LOCAL_DELIVERY_FEE = 40;   // पास के पिनकोड के लिए फीस
const REMOTE_DELIVERY_FEE = 50;  // दूर के पिनकोड के लिए फीस

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
  params: async (req, file) => {
    // Folder logic
    let folderPath = 'ecommerce/general';
    if (req.originalUrl.includes('products')) folderPath = 'ecommerce/products';
    else if (req.originalUrl.includes('categories')) folderPath = 'ecommerce/categories';
    else if (req.originalUrl.includes('subcategories')) folderPath = 'ecommerce/subcategories';
    else if (req.originalUrl.includes('banners')) folderPath = 'ecommerce/banners';
    else if (req.originalUrl.includes('splash')) folderPath = 'ecommerce/splash';

    // Resource type logic (Image vs Video)
    const isVideo = file.mimetype.startsWith('video');

    return {
      folder: folderPath,
      resource_type: isVideo ? 'video' : 'image',
      allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm'],
      // Agar video hai toh transformation bhi add kar sakte hain
      public_id: Date.now() + '-' + file.originalname.split('.')[0],
    };
  },
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit (Video ke liye zaroori hai)
});
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
 * HELPER: Save Personal Notification to DB & Send via FCM
 */
async function sendAndSavePersonalNotification(userId, title, body, data = {}, imageUrl = null) {
  try {
    // 1. Save to MongoDB
    await Notification.create({
      user: userId,
      title: title,
      body: body,
      type: data.type || 'personal',
      data: data,
      sentAt: new Date()
    });

    // 2. Fetch User Token & Send FCM
    const user = await User.findById(userId).select('fcmToken');
    if (user && user.fcmToken) {
      await sendPushNotification(user.fcmToken, title, body, data, imageUrl);
    }
  } catch (err) {
    console.error('Error in sendAndSavePersonalNotification:', err.message);
  }
}

/**
 * HELPER: Save Personal Notification to DB & Send via FCM
 */
async function sendAndSavePersonalNotification(userId, title, body, data = {}, imageUrl = null) {
  try {
    // 1. Save to MongoDB
    await Notification.create({
      user: userId,
      title: title,
      body: body,
      type: data.type || 'personal',
      data: data,
      sentAt: new Date()
    });

    // 2. Fetch User Token & Send FCM
    const user = await User.findById(userId).select('fcmToken');
    if (user && user.fcmToken) {
      await sendPushNotification(user.fcmToken, title, body, data, imageUrl);
    }
  } catch (err) {
    console.error('Error in sendAndSavePersonalNotification:', err.message);
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
 * HELPER: Check if a location is blocked (Pincode or Geo-Fence)
 */
async function checkLocationBlock(pincode, lat, lng) {
    try {
        const settings = await AppSettings.findOne({ singleton: true });
        if (!settings || !settings.deliveryConfig) return { blocked: false };

        const config = settings.deliveryConfig;

        // 1. Check Pincode Block
        if (pincode && config.blockedPincodes && config.blockedPincodes.includes(pincode)) {
            return { blocked: true, reason: `Delivery is currently unavailable in pincode ${pincode}.` };
        }

        // 2. Check Geo-Zone Block (Flood, Riots, etc.)
        if (lat && lng && config.blockedZones && config.blockedZones.length > 0) {
            const userLat = parseFloat(lat);
            const userLng = parseFloat(lng);

            for (const zone of config.blockedZones) {
                const distance = getDistanceFromLatLonInKm(userLat, userLng, zone.lat, zone.lng);
                if (distance <= zone.radiusKm) {
                    return { blocked: true, reason: `Service paused in your area: ${zone.reason}` };
                }
            }
        }

        return { blocked: false };
    } catch (err) {
        console.error('Error checking location block:', err.message);
        return { blocked: false }; // Fail safe: Allow if error occurs
    }
}

/**
 * HELPER: Calculate Fee based on KM
 */
/**
 * ✅ UPDATED HELPER: Calculate Fee based on Admin Settings
 */
function getDynamicDeliveryFee(distanceKm, config) {
    // अगर Admin ने कुछ सेट नहीं किया तो Default values (20, 2, 10) यूज़ होंगी
    const basePrice = config?.baseCharge || 10; 
    const baseKm = config?.baseKm || 2;
    const perKmPrice = config?.extraPerKmCharge || 10;

    if (!distanceKm || distanceKm <= 0) return basePrice;

    if (distanceKm <= baseKm) {
        return basePrice; // Base KM के अंदर
    } else {
        const extraKm = distanceKm - baseKm;
        return Math.round(basePrice + (extraKm * perKmPrice)); 
    }
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
    
    // ✅ ROLE: 'driver' is already included
    role: { 
        type: String, 
        enum: ['user', 'seller', 'admin', 'delivery', 'provider', 'driver'], 
        default: 'user', 
        index: true 
    },
    
    pincodes: { type: [String], default: [] },
    
    // General Account Approval (Login enable/disable)
    approved: { type: Boolean, default: true, index: true },

    // 🖨️ ✅ NEW: PRINT SERVICE PERMISSION STATUS
    // None = अभी तक अप्लाई नहीं किया
    // Pending = अप्लाई किया है, एडमिन का वेट कर रहा है
    // Approved = एडमिन ने परमिशन दे दी (User को दिखेगा)
    // Rejected = एडमिन ने मना कर दिया
    printServiceStatus: { 
        type: String, 
        enum: ['None', 'Pending', 'Approved', 'Rejected'], 
        default: 'None',
        index: true 
    },

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
    
    lockExpiresAt: { type: Date, default: null }, 
    blockReason: { type: String, default: null }, 
    
    // ======== ✨ EXISTING PAYOUT DETAILS ✨ ========
    payoutDetails: {
        razorpayContactId: { type: String, default: null }, 
        razorpayFundAccountId: { type: String, default: null, index: true }, 
        accountType: { type: String, enum: ['bank', 'vpa', null], default: null },
        bankAccountNumber: { type: String, default: null },
        ifsc: { type: String, default: null },
        vpa: { type: String, default: null } 
    },
    
    // ======== 🚖 DRIVER / RIDE BOOKING FIELDS 🚖 ========
    vehicleType: { 
        type: String, 
        enum: ['Bike', 'Auto', 'Car', 'Tempo', 'E-Rickshaw'],
        default: null 
    },
    
    walletBalance: { type: Number, default: 0 }, 
    isLocked: { type: Boolean, default: false }, 
    isOnline: { type: Boolean, default: false }, 
    
    // GeoJSON for finding nearest driver
    location: {
        type: { type: String, default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] } // [longitude, latitude]
    },
    // ========================================================

    // Track last active time
    lastActiveAt: { type: Date, default: Date.now, index: true },

    fcmToken: { type: String, default: null }
}, { timestamps: true });

// ✅ IMPORTANT: Create Index for Geospatial Queries
userSchema.index({ location: '2dsphere' });

const User = mongoose.model('User', userSchema);

const printJobSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  originalName: String,
  fileUrl: String,      // Cloudinary PDF URL
  publicId: String,
  
  // ✅ NEW FIELDS ADDED (Required for App to work)
  copies: { type: Number, default: 1 },
  printType: { type: String, enum: ['bw', 'color'], default: 'bw' },
  sideType: { type: String, enum: ['single', 'double'], default: 'single' },
  paperSize: { type: String, default: 'A4' },
  instructions: String,
  
  // Payment & Cost Details
  printCost: Number,
  sellerEarnings: Number,
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  
  // Settlement Details
  payoutStatus: { type: String, enum: ['Pending', 'Settled'], default: 'Pending' },
  transactionId: String,
  settledAt: Date,

  status: { type: String, enum: ['Pending', 'Printed', 'Rejected'], default: 'Pending' },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24h Expiry
}, { timestamps: true });

const PrintJob = mongoose.model('PrintJob', printJobSchema);

const auditLogSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true }, // उदा: 'FAILED_LOGIN', 'WALLET_RECHARGE'
    status: { type: String, enum: ['Success', 'Warning', 'Critical'], default: 'Success' },
    ipAddress: String,
    userAgent: String,
    details: Object, // अतिरिक्त जानकारी के लिए
    timestamp: { type: Date, default: Date.now }
}, { timestamps: true });

const AuditLog = mongoose.model('AuditLog', auditLogSchema);
const printableFormSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true }, // उदा: "बिहार आय प्रमाण पत्र फॉर्म"
  description: String,
  fileUrl: String,      // PDF फाइल का लिंक
  publicId: String,
  pricePerCopyBW: Number,    // B/W प्रिंट का फिक्स रेट
  pricePerCopyColor: Number, // Color प्रिंट का फिक्स रेट
  category: String,          // उदा: "Government Form", "Booklet", "Exam Paper"
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const PrintableForm = mongoose.model('PrintableForm', printableFormSchema);


// --- COMPLAINT MODEL (For Village Admin Control) ---
const complaintSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Customer
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Driver (Optional)
    ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' }, // Ride Ref
    reason: { type: String, required: true }, // "Rude behavior", "Late", "Overcharge"
    status: { type: String, enum: ['Pending', 'Resolved', 'Ignored'], default: 'Pending' },
    adminNote: String
}, { timestamps: true });

const Complaint = mongoose.model('Complaint', complaintSchema);

// ==========================================
// 📚 PRINT LIBRARY SCHEMA (Ready-to-Print Files)
// ==========================================
const printLibrarySchema = new mongoose.Schema({
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true }, // e.g. "Class 10 Math Notes"
    description: String,
    category: { type: String, default: 'General' }, // e.g. "Education", "Forms"
    
    fileUrl: { type: String, required: true }, // Cloudinary Link
    publicId: String,
    
    totalPages: { type: Number, required: true }, // Page Count (Auto or Manual)
    pricePerCopy: { type: Number, default: 0 }, // Optional: Extra fee for content
    
    isActive: { type: Boolean, default: true }
}, { timestamps: true });

const PrintLibrary = mongoose.model('PrintLibrary', printLibrarySchema);



// 1. Vehicle Rates (Hardcoded in logic, but schema needed for future)
const vehicleTypeSchema = new mongoose.Schema({
    name: { type: String, required: true },
    baseFare: Number,
    perKmRate: Number
});

// --- Personal Notification Schema (User Specific) ---
// ✅ ISSE ADD KAREIN (Bell Icon History ke liye)
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  type: { type: String, default: 'personal' }, // 'order', 'wallet', 'promo'
  isRead: { type: Boolean, default: false },
  data: { type: Object }, // Store extra data like orderId
  sentAt: { type: Date, default: Date.now }
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema);


// 2. Ride Schema
const rideSchema = new mongoose.Schema({
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    vehicleType: { type: String, required: true },
    
    pickupLocation: { 
        address: String, 
        coordinates: [Number] // [Longitude, Latitude]
    },
    dropLocation: { 
        address: String, 
        coordinates: [Number] // [Longitude, Latitude]
    },
    
    distanceKm: Number,
    estimatedFare: Number,
    finalFare: Number,
    commissionAmount: Number,
    otp: String,
    
    status: { 
        type: String, 
        enum: ['Requested', 'Accepted', 'InProgress', 'Completed', 'Cancelled'], 
        default: 'Requested' 
    },
    paymentStatus: { type: String, default: 'Pending' },

    // ✅ NEW: Fields for "Nearest Driver First" Logic
    // यह लिस्ट उन सभी ड्राइवरों की है जो राइड के लिए उपलब्ध हैं (दूरी के अनुसार सॉर्ट की गई)
    potentialDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 
    
    // यह ट्रैक करता है कि लिस्ट में से किस नंबर के ड्राइवर को अभी रिक्वेस्ट भेजी जा रही है
    currentDriverIndex: { type: Number, default: 0 }, 
    
    // जिन ड्राइवरों ने राइड डिक्लाइन (Decline) कर दी, उनकी लिस्ट
    rejectedDrivers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], 

    requestTime: { type: Date, default: Date.now } // रिक्वेस्ट का समय (Timeout कैलकुलेशन के लिए)

}, { timestamps: true });



// 3. Wallet Transaction Schema
const walletTransactionSchema = new mongoose.Schema({
    // ✅ Driver और Seller दोनों के लिए
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 

    // ✅ Ride (Driver के लिए) और Order (Seller के लिए)
    rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },

    // 🛡️ सुरक्षा: Unique Payment ID (हैक रोकने के लिए)
    // 'unique: true' और 'sparse: true' का मतलब है कि एक Payment ID दोबारा इस्तेमाल नहीं हो पाएगी
    razorpayPaymentId: { type: String, unique: true, sparse: true },

    type: { type: String, enum: ['Credit', 'Debit'], required: true },
    amount: { type: Number, required: true },
    balanceBefore: Number,
    balanceAfter: Number,
    description: String,
    
    // ✅ ट्रांजैक्शन का स्टेटस ट्रैक करने के लिए
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Success' }
}, { timestamps: true });

const WalletTransaction = mongoose.model('WalletTransaction', walletTransactionSchema);



// 1. User Schema को अपडेट करें (role में 'provider' जोड़ें)
// अपना पुराना userSchema ढूंढें और 'role' वाली लाइन को इससे बदल दें:
// role: { type: String, enum: ['user', 'seller', 'admin', 'delivery', 'provider'], default: 'user', index: true },

// 2. Service Booking Model (नया मॉडल बनाएँ)
// --- SERVICE BOOKING SCHEMA ---
const serviceBookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  service: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true }, 
  
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, 
  
  bookingDate: { type: Date, required: true }, 
  timeSlot: { type: String, required: true },
  
  address: {
    street: String,
    village: String, 
    city: String,
    pincode: String,
    phone: String
  },
  
  status: { 
    type: String, 
    // Added 'Rejected' to enum to prevent validation error
    enum: ['Pending', 'Accepted', 'OnTheWay', 'InProgress', 'Completed', 'Cancelled', 'Rejected'], 
    default: 'Pending' 
  },
  
  amount: { type: Number, required: true },
  paymentMethod: { type: String, default: 'cod' },
  paymentStatus: { type: String, default: 'pending' }, // Added for better tracking
  startOtp: { type: String },
  notes: String,

  // ✅ FIX: Ye field missing tha, isliye crash ho raha tha


  
  history: [{
    status: String,
    timestamp: { type: Date, default: Date.now },
    note: String
  }]

}, { timestamps: true });

const ServiceBooking = mongoose.model('ServiceBooking', serviceBookingSchema);

// --------- Models ----------


// ⚙️ APP SETTINGS SCHEMA (Admin Configuration)
// ==========================================
const appSettingsSchema = new mongoose.Schema({
  singleton: { type: Boolean, default: true, unique: true, index: true },
  
  // Platform Fees
  platformCommissionRate: { type: Number, default: 0.05, min: 0, max: 1 },
  productCreationFee: { type: Number, default: 10 }, 
  
  // 🎨 App Theme Settings
  theme: {
    primaryColor: { type: String, default: '#2874F0' },
    secondaryColor: { type: String, default: '#FFC200' },
    backgroundColor: { type: String, default: '#F1F3F6' },
    searchBarColor: { type: String, default: '#FFFFFF' },
    categoryLayout: { type: String, enum: ['horizontal', 'grid', 'list'], default: 'horizontal' }
  },

  // ✅ PRINTING CONFIGURATION
  printConfig: {
      bwRatePerPage: { type: Number, default: 2 },       // Admin Default B/W Rate
      colorRatePerPage: { type: Number, default: 10 },   // Admin Default Color Rate
      adminPrintCommission: { type: Number, default: 0.10 } // Admin Commission on Print (10%)
  },

  // ✅ NEW FIELD: Print COD Control (True = COD Allowed, False = Online Only)
  allowPrintCOD: { type: Boolean, default: false }, 

  // ✅ DELIVERY CONFIGURATION
  deliveryConfig: {
      globalRadiusKm: { type: Number, default: 50 }, 
      baseCharge: { type: Number, default: 20 },       
      baseKm: { type: Number, default: 2 },           
      extraPerKmCharge: { type: Number, default: 10 }, 
      blockedPincodes: [{ type: String }], 
      blockedZones: [{
          lat: Number,
          lng: Number,
          radiusKm: { type: Number, default: 1 },
          reason: String
      }]
  }
}, { timestamps: true });

// 👇 THIS LINE IS CRITICAL - DO NOT FORGET IT 👇
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
  sortOrder: { type: Number, default: 0, index: true },

  // ✅ NEW: Design properties for Flipkart-style UI
  bgColor: { type: String, default: '#FFFFFF' },        // Circle/Square Background Color
  textColor: { type: String, default: '#000000' },      // Category Name Color
  shape: { type: String, enum: ['circle', 'square', 'rectangle'], default: 'circle' }, // Shape
  borderColor: { type: String, default: 'transparent' } // Optional Border
}, { timestamps: true });

const Category = mongoose.model('Category', categorySchema);

// --- NEW SERVICE MODEL (Separated from Product) ---
const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g., AC Repair, Haircut
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // Jo service de raha hai
  
  price: { type: Number, required: true }, // Service Charge
  visitCharge: { type: Number, default: 0 }, // Visiting Fee (if any)
  
  description: String,
  experience: { type: String, default: '0 Years' }, // e.g., 5 Years
  
  images: [{
    url: String,
    publicId: String
  }],
  
  // Village/Location specific availability
  villages: [String], // Kin gaon me service available hai
  isAvailable: { type: Boolean, default: true },
  
  rating: { type: Number, default: 0 },
  totalReviews: { type: Number, default: 0 }

}, { timestamps: true });

const Service = mongoose.model('Service', serviceSchema);

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
  
  // ❌ Main price and stock fields are removed (Variants handle this now)
  
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
  
  // ✅ VARIANTS SECTION
  variants: [{
      color: { type: String },
      size: { type: String },
      price: { type: Number, required: true },
      originalPrice: { type: Number }, 
      costPrice: { type: Number }, 
      stock: { type: Number, required: true, default: 0 },
      sku: { type: String }, 
      images: [{ 
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
  
  isGlobal: { type: Boolean, default: false, index: true }, 
  
  // ✅✅ NEW FIELDS ADDED HERE (Alerts & Daily Update ke liye) ✅✅
  dailyPriceUpdate: { type: Boolean, default: false }, // Agar true hai, to roj subah notification jayega
  lowStockThreshold: { type: Number, default: 5 },     // Isse kam stock hone par alert jayega
  // -------------------------------------------------------------

  // ✅ NEW FIELD: Product Approval Status
  // Default is false so sellers' products are hidden until approved.
  isApproved: { type: Boolean, default: false, index: true }, 

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
    
    // ⭐️ EXISTING VARIANT FIELDS ⭐️
    selectedColor: { type: String, required: false }, 
    selectedSize: { type: String, required: false },

    // ✅ CRITICAL FIX: PRINT JOB DETAILS ADDED HERE ✅
    // These fields are required for the "Print Service" to work
    isPrintJob: { type: Boolean, default: false },
    printMeta: {
        fileUrl: String,      // PDF Link from Cloudinary
        originalName: String, // Original File Name
        copies: Number,       // Number of copies
        printType: String,    // 'bw' or 'color'
        sideType: String,     // 'single' or 'double'
        paperSize: String,    // 'A4'
        totalCost: Number     // Calculated Print Cost
    }
    // --------------------------------------------------
  }],

  shippingAddress: { type: String, required: true },
  
  deliveryStatus: { 
    type: String, 
    enum: [
        'Pending', 
        'Processing', 
        'Shipped', 
        'Delivered', 
        'Cancelled', 
        'Payment Pending', 
        'Return Requested',
        'Return Accepted by Admin', 
        'Return In Transit',        
        'Return Completed'
    ], 
    default: 'Pending', 
    index: true 
  }, 
  
  paymentMethod: { type: String, enum: ['cod', 'razorpay', 'razorpay_cod'], required: true, index: true },
  paymentId: String,
  paymentStatus: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending', index: true },
  
  pincode: String,
  totalAmount: Number, 
  taxRate: { type: Number, default: (typeof GST_RATE !== 'undefined' ? GST_RATE : 0) },
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
    
    // 🚨 MANUAL REFUND FIELDS 🚨
    upiId: String, 
    bankAccountNumber: String, 
    ifsc: String, 
    // -------------------------
    
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
    // ⭐️ EXISTING VARIANT FIELDS ⭐️
    selectedColor: { 
      type: String 
    },
    selectedSize: { 
      type: String 
    },
    
    // ✅ NEW: PRINT JOB FIELDS ADDED HERE ✅
    // This allows the cart to tell if an item is a file for printing or a regular product
    isPrintJob: { 
      type: Boolean, 
      default: false 
    },
    printMeta: {
        fileUrl: String,      // Link to the PDF file on Cloudinary
        originalName: String, // The name of the file user uploaded
        copies: Number,       // How many sets
        printType: String,    // 'bw' or 'color'
        sideType: String,     // 'single' or 'double'
        paperSize: String,    // 'A4', etc.
        totalCost: Number     // Price calculated by Flutter app (e.g., ₹50)
    }
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
  
  // ✅ ADDED COORDINATES (Required for Radius Check)
  lat: { type: Number }, 
  lng: { type: Number },
  
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
    enum: [
        'Pending',       // Forward Delivery: Job available for claiming
        'Accepted',      // Forward Delivery: Claimed by a boy
        'PickedUp',      // Forward Delivery: Package collected from seller
        'Delivered',     // Forward Delivery: Delivered to customer

        // --- NEW RETURN/REVERSE LOGISTICS STATUSES ---
        'ReturnPending',    // Reverse Logistics: Return job available for claiming (created upon admin approval)
        'ReturnAccepted',   // Reverse Logistics: Claimed by a boy
        'ReturnPickedUp',   // Reverse Logistics: Package collected from customer
        'ReturnDelivered',  // Reverse Logistics: Delivered back to seller/warehouse
        
        'Cancelled'      // Applies to either flow
    ], 
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

// --- Scheduled Notification Schema (Admin Broadcasts) ---
const scheduledNotificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  body: { type: String, required: true },
  imageUrl: { type: String, default: null },
  // Target: 'all' = sabko, 'users' = customers, 'sellers' = dukan wale
  target: { type: String, enum: ['all', 'users', 'sellers', 'delivery_boys'], required: true },
  scheduledAt: { type: Date, required: true },
  isSent: { type: Boolean, default: false },
  sentAt: Date,
}, { timestamps: true });

scheduledNotificationSchema.index({ isSent: 1, scheduledAt: 1 });
const ScheduledNotification = mongoose.model('ScheduledNotification', scheduledNotificationSchema);

// --- Database Seeding Function ---
async function seedDatabaseData() {
  try {
    const settingsCount = await AppSettings.countDocuments();
    if (settingsCount === 0) {
      console.log('Creating default app settings...');
      await AppSettings.create({ singleton: true, platformCommissionRate: 0.05 });
      console.log('Default app settings created (5% commission).');
    }

    // Inside seedDatabaseData function...

const serviceCategoryCount = await Category.countDocuments({ type: 'service' });
if (serviceCategoryCount === 0) {
  console.log('Creating Village Service categories...');
  const serviceCategories = [
    { name: 'Doctor (Medical)', slug: 'doctor', type: 'service', sortOrder: 10 },
   
  ];
  await Category.insertMany(serviceCategories);
  console.log('Village Service categories created.');
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

const logActivity = async (req, action, status, details = {}) => {
    try {
        await AuditLog.create({
            userId: req.user ? req.user._id : null,
            action,
            status,
            ipAddress: req.ip || req.headers['x-forwarded-for'],
            userAgent: req.headers['user-agent'],
            details
        });
    } catch (err) {
        console.error("Audit Log Failed:", err.message);
    }
};

const printStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'ecommerce/print_jobs',
    format: 'pdf', // यह हर फ़ाइल को PDF में बदल देगा
    resource_type: 'auto'
  },
});
const uploadPrint = multer({ storage: printStorage });


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

    // ✅ NEW: Update lastActiveAt automatically (Fire and forget)
    User.findByIdAndUpdate(req.user._id, { lastActiveAt: new Date() }).exec();

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
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
        
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
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
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

// ✅ UPDATED REGISTER ROUTE (With ₹500 Seller Bonus)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role = 'user', pincodes, vehicleType } = req.body;
    
    // --- 1. Validation ---
    if (!name || !password || !phone) return res.status(400).json({ message: 'Name, password, and phone number are required' });

    if (role === 'seller' && !email) {
        return res.status(400).json({ message: 'Email is required for seller registration.' });
    }
    if ((role === 'user' || role === 'delivery') && !phone) {
      return res.status(400).json({ message: 'Phone number is required for user/delivery registration.' });
    }
    
    // Driver Validation
    if (role === 'driver' && !vehicleType) {
        return res.status(400).json({ message: 'Vehicle Type is required for drivers.' });
    }

    // --- 2. Check Existing User ---
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

    // --- 3. Determine Status & Bonus ---
    let approved = true;
    let initialBalance = 0; 
    const SELLER_BONUS_AMOUNT = 500;

    if (role === 'seller') {
      approved = false; // Sellers need approval
      initialBalance = SELLER_BONUS_AMOUNT; // 🎁 GIVE 500 BONUS
    }

    // --- 4. Create User ---
    const user = await User.create({ 
        name, 
        email, 
        password: hashed, 
        phone, 
        role, 
        pincodes: Array.isArray(pincodes) ? pincodes : [], 
        approved,
        vehicleType: role === 'driver' ? vehicleType : null,
        walletBalance: initialBalance // ✅ Apply Bonus Here
    });

    // --- 5. 🎁 BONUS LOGIC: Create Transaction & Notify ---
    if (role === 'seller') {
      // A. Create Transaction History
      await WalletTransaction.create({
          seller: user._id,
          type: 'Credit',
          amount: SELLER_BONUS_AMOUNT,
          balanceBefore: 0,
          balanceAfter: SELLER_BONUS_AMOUNT,
          description: '🎁 Welcome Bonus! (Registration Reward)'
      });

      // B. Notify Admin
      await notifyAdmin(`🆕 New Seller Registered (pending approval)\n\nName: ${user.name}\nEmail: ${user.email}\nPhone: ${user.phone}\nWallet: Credited ₹500 Bonus`);
      
      // C. Notify Seller (WhatsApp)
      if (user.phone) {
          const welcomeMsg = `🎉 Welcome to Quick Sauda, ${user.name}!\n\nCongratulations! You have received a ₹500 Welcome Bonus in your wallet. Your account is currently under review for approval.`;
          await sendWhatsApp(user.phone, welcomeMsg);
      }
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
    
    res.status(201).json({ 
        token, 
        user: { 
            id: user._id, 
            name: user.name, 
            email: user.email, 
            phone: user.phone, 
            role: user.role, 
            pincodes: user.pincodes, 
            approved: user.approved,
            vehicleType: user.vehicleType,
            walletBalance: user.walletBalance // Return updated balance
        } 
    });

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


    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '365d' });
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



// ✅ UPDATED: Update Profile (Fixed to read lat/lng from pickupAddress)
// ✅ SECURITY-ENHANCED: Update Profile
app.put('/api/auth/profile', protect, async (req, res) => {
  try {
    const { name, phone, pincodes, pickupAddress, lat, lng } = req.body;
    
    // Use select('-password') as an extra layer of safety during fetch
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name) user.name = name;
    if (phone) user.phone = phone;
    
    if (pincodes !== undefined) { 
        user.pincodes = Array.isArray(pincodes) ? pincodes : []; 
    } 

    // ✅ ROBUST EXTRACTION: Handle lat/lng from root or nested object
    const latitude = lat || (pickupAddress ? pickupAddress.lat : null);
    const longitude = lng || (pickupAddress ? pickupAddress.lng : null);

    if (latitude && longitude) {
        user.location = {
            type: 'Point',
            // MongoDB GeoJSON expects [Longitude, Latitude]
            coordinates: [parseFloat(longitude), parseFloat(latitude)] 
        };
    }

    if (pickupAddress) {
      const currentAddress = user.pickupAddress || {};
      user.pickupAddress = {
        street: pickupAddress.street || currentAddress.street,
        village: pickupAddress.village || currentAddress.village,
        landmark: pickupAddress.landmark || currentAddress.landmark,
        city: pickupAddress.city || currentAddress.city,
        state: pickupAddress.state || currentAddress.state,
        pincode: pickupAddress.pincode || currentAddress.pincode,
        isSet: !!((pickupAddress.street || currentAddress.street) && 
                  (pickupAddress.pincode || currentAddress.pincode))
      };
    }

    await user.save();

    // 🛡️ DATA SANITIZATION: Convert to object and ensure password is gone
    const safeUserResponse = user.toObject();
    delete safeUserResponse.password; // Double check

    res.json(safeUserResponse);
  } catch (err) {
    console.error('🛡️ Profile Update Error:', err.message);
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
        const { active, userPincode, type } = req.query;

        // 1. Product Match Condition
        // हम पहले प्रोडक्ट्स ढूंढ़ेंगे। अगर प्रोडक्ट मिलेगा, तभी उसकी कैटेगरी लिस्ट में आएगी।
        const productMatch = { 
            isApproved: true, // ✅ सिर्फ Approved प्रोडक्ट्स वाली कैटेगरी दिखेगी
            // stock: { $gt: 0 } // (Optional) अगर आप चाहते हैं कि Out of stock वाले प्रोडक्ट्स की कैटेगरी भी न दिखे तो इस लाइन को uncomment करें
        };

        // अगर यूजर ने पिनकोड दिया है, तो लोकेशन फिल्टर लगाएं
        if (userPincode) {
            productMatch.$or = [
                { isGlobal: true },
                { pincodes: userPincode }
            ];
        }

        // 2. Category Match Condition (Active & Type)
        const categoryMatchStage = {};
        
        // अगर active पैरामीटर आया है तो चेक करें, वरना Default true मानें (Users को सिर्फ Active दिखें)
        if (typeof active !== 'undefined') {
            categoryMatchStage['categoryDetails.isActive'] = active === 'true';
        } else {
            categoryMatchStage['categoryDetails.isActive'] = true; 
        }

        if (type) {
            categoryMatchStage['categoryDetails.type'] = type;
        }

        // 3. Unified Aggregation Pipeline
        const categories = await Product.aggregate([
            // Stage 1: Find valid Products first (Isse empty categories filter ho jayengi)
            { $match: productMatch },

            // Stage 2: Group by Category (Duplicates hatane ke liye)
            { $group: { _id: '$category' } },

            // Stage 3: Fetch full Category Details
            { $lookup: {
                from: 'categories', 
                localField: '_id',
                foreignField: '_id',
                as: 'categoryDetails'
            }},
            { $unwind: '$categoryDetails' },

            // Stage 4: Apply Category Filters (Active/Type)
            { $match: categoryMatchStage },

            // Stage 5: Format Output with Design Fields
            { $project: {
                _id: '$categoryDetails._id',
                name: '$categoryDetails.name',
                slug: '$categoryDetails.slug',
                isActive: '$categoryDetails.isActive',
                image: '$categoryDetails.image',
                type: '$categoryDetails.type',
                sortOrder: '$categoryDetails.sortOrder',
                // Design Fields
                bgColor: '$categoryDetails.bgColor',
                textColor: '$categoryDetails.textColor',
                shape: '$categoryDetails.shape',
                borderColor: '$categoryDetails.borderColor'
            }},

            // Stage 6: Sort by SortOrder (Order Fast)
            { $sort: { sortOrder: 1, name: 1 } }
        ]);

        res.json(categories);

    } catch (err) {
        console.error('Error fetching categories:', err); 
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
    const { active, type } = req.query; // Added type here
    const filter = {};
    
    if (typeof active !== 'undefined') filter.isActive = active === 'true';
    if (type) filter.type = type; // Added type filter

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
    // ✅ Extract new design fields from request body
    const { name, type, sortOrder, bgColor, textColor, shape, borderColor } = req.body;
    
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    
    const category = await Category.create({
      name,
      slug,
      type: type || 'product',
      sortOrder: sortOrder || 0,
      
      // ✅ Save Design Properties (with defaults if not provided)
      bgColor: bgColor || '#FFFFFF',
      textColor: textColor || '#000000',
      shape: shape || 'circle',
      borderColor: borderColor || 'transparent',
      
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
    // ✅ Extract new design fields along with existing ones
    const { name, isActive, type, sortOrder, bgColor, textColor, shape, borderColor } = req.body;
    
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ message: 'Category not found' });

    // --- Image Update Logic ---
    if (req.file) {
      if (category.image && category.image.publicId) await cloudinary.uploader.destroy(category.image.publicId);
      category.image = { url: req.file.path, publicId: req.file.filename };
    }

    // --- Name & Slug Logic ---
    if (name) {
      category.name = name;
      category.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    // --- ✅ Update Design Fields ---
    if (bgColor) category.bgColor = bgColor;
    if (textColor) category.textColor = textColor;
    if (shape) category.shape = shape;
    if (borderColor) category.borderColor = borderColor;

    // --- Update Standard Fields ---
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


// ✅ UPDATED: Main Products Route with Distance Calculation
// ✅ UPDATED: Main Products Route (With Block Logic & Approval Check)
app.get('/api/products', async (req, res) => {
  try {
    const { search, minPrice, maxPrice, categoryId, brand, subcategoryId, sellerId, userPincode, lat, lng } = req.query;
    const { ObjectId } = mongoose.Types;

    // 🚫 --- BLOCK CHECK START --- 
    // If user provided location/pincode, check if blocked.
    // If blocked, return EMPTY ARRAY immediately (Products won't show).
    if (userPincode || (lat && lng)) {
        const blockStatus = await checkLocationBlock(userPincode, lat, lng);
        if (blockStatus.blocked) {
            console.log(`🚫 Products hidden due to block: ${blockStatus.reason}`);
            return res.json([]); // Return empty list
        }
    }
    // 🚫 --- BLOCK CHECK END ---

    // --- 1. Build initial match conditions ---
    const initialMatchStage = {};
    
    // ✅ ONLY SHOW APPROVED PRODUCTS
    initialMatchStage.isApproved = true; 
    
    initialMatchStage['variants.0'] = { $exists: true };
    
    if (search) {
      initialMatchStage.$or = [
        { name: { $regex: search, $options: "i" } },
        { shortDescription: { $regex: search, $options: "i" } },
        { fullDescription: { $regex: search, $options: "i" } }
      ];
    }
    
    if (categoryId && mongoose.isValidObjectId(categoryId)) initialMatchStage.category = new ObjectId(categoryId);
    if (subcategoryId && mongoose.isValidObjectId(subcategoryId)) {
      initialMatchStage.$or = [
          { subcategory: new ObjectId(subcategoryId) },
          { childCategory: new ObjectId(subcategoryId) } 
      ];
    }
    if (brand) initialMatchStage.brand = { $regex: brand, $options: "i" };
    if (sellerId && mongoose.isValidObjectId(sellerId)) initialMatchStage.seller = new ObjectId(sellerId);
    
    const pipeline = [{ $match: initialMatchStage }];
    
    // --- 2. Join Seller ---
    if (userPincode) {
      pipeline.push(
        { $lookup: { from: "users", localField: "seller", foreignField: "_id", as: "sellerDetails" } },
        { $unwind: "$sellerDetails" }, 
        { $match: { "sellerDetails.pincodes": userPincode } },
        { $addFields: { seller: "$sellerDetails" } },
        { $unset: "sellerDetails" }
      );
    } else {
      pipeline.push(
        { $lookup: { from: "users", localField: "seller", foreignField: "_id", as: "seller" } },
        { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } }
      );
    }

    if (req.query.sample === 'true') {
        const limit = parseInt(req.query.limit) || 20;
        pipeline.push({ $sample: { size: limit } });
    }

    pipeline.push({
        $addFields: {
            price: { $min: "$variants.price" },
            originalPrice: { $max: "$variants.originalPrice" }, 
            stock: { $sum: "$variants.stock" }, 
            variants: "$variants" 
        }
    });

    // --- 3. Join Categories ---
    pipeline.push(
      { $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "category" } },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1, price: 1, originalPrice: 1, images: 1, stock: 1, unit: 1, brand: 1, variants: 1, 
          shortDescription: 1, isTrending: 1, 
          "seller._id": 1, "seller.name": 1, "seller.email": 1, "seller.location": 1,
          "category.name": 1, createdAt: 1
        }
      }
    );

    let products = await Product.aggregate(pipeline);

    // ✅ 4. Calculate Distance
    if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);

        products = products.map(p => {
            let dist = null;
            if (p.seller && p.seller.location && p.seller.location.coordinates) {
                const sLng = p.seller.location.coordinates[0];
                const sLat = p.seller.location.coordinates[1];
                dist = parseFloat(getDistanceFromLatLonInKm(userLat, userLng, sLat, sLng).toFixed(1));
            }
            return { ...p, distanceKm: dist };
        });

        // Sort by distance (Nearest first)
        products.sort((a, b) => (a.distanceKm || 9999) - (b.distanceKm || 9999));
    }

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
// [NEW] API Endpoint to get products available in a specific pincode
// [UPDATED] API Endpoint to get products by pincode + Calculate Distance
// ✅ UPDATED: Get products by pincode (With Block Check)
// ✅ UPDATED: Get products by pincode (With Block Check & Admin Approval Filter)
app.get('/api/products/pincode/:pincode', async (req, res) => {
    try {
        const userPincode = req.params.pincode;
        
        // 1. Get User Coordinates
        const userLat = req.query.lat ? parseFloat(req.query.lat) : null;
        const userLng = req.query.lng ? parseFloat(req.query.lng) : null;

        if (!userPincode) {
            return res.status(400).json({ message: 'Pincode is required.' });
        }

        // 🚫 --- BLOCK CHECK START ---
        // Check if this pincode or lat/lng is blocked
        const blockStatus = await checkLocationBlock(userPincode, userLat, userLng);
        if (blockStatus.blocked) {
            // Return 404 or 403 so the frontend knows to show "Service Unavailable" screen
            return res.status(403).json({ 
                message: blockStatus.reason, 
                blocked: true 
            });
        }
        // 🚫 --- BLOCK CHECK END ---

        // --- Aggregation Pipeline ---
        let products = await Product.aggregate([
            // Stage 1: Filter products by Pincode OR isGlobal
            { $match: { 
                isApproved: true, // ✅ NEW: Only show Approved Products
                $or: [
                    { isGlobal: true },
                    { pincodes: userPincode }
                ],
                stock: { $gt: 0 } // Only in-stock
            }},
            
            // Stage 2: Join with Seller
            { $lookup: {
                from: "users",
                localField: "seller",
                foreignField: "_id",
                as: "seller"
            }},
            { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
            
            // Stage 3: Join with Category
            { $lookup: {
                from: "categories",
                localField: "category",
                foreignField: "_id",
                as: "category"
            }},
            { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
            
            // Stage 4: Project fields
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
                isApproved: 1, // Optional: return status if needed by frontend logic
                "seller.name": 1,
                "seller.location": 1, 
                "category.name": 1,
                createdAt: 1,
                pincodes: 1,
                isGlobal: 1,
            }},
            // Stage 5: Sort by newest first
            { $sort: { createdAt: -1 } }
        ]);

        // 2. Calculate Distance
        if (userLat && userLng) {
            products = products.map(product => {
                let distance = null;
                if (product.seller && product.seller.location && 
                    product.seller.location.coordinates && 
                    product.seller.location.coordinates.length === 2) {
                    
                    const sellerLng = product.seller.location.coordinates[0];
                    const sellerLat = product.seller.location.coordinates[1];
                    const distRaw = getDistanceFromLatLonInKm(userLat, userLng, sellerLat, sellerLng);
                    distance = parseFloat(distRaw.toFixed(1));
                }
                return { ...product, distanceKm: distance };
            });

            products.sort((a, b) => {
                if (a.distanceKm === null) return 1;
                if (b.distanceKm === null) return -1;
                return a.distanceKm - b.distanceKm;
            });
        }

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



app.post('/api/cart', protect, async (req, res) => {
    try {
        const { 
            productId, 
            qty = 1, 
            selectedVariant,
            // ✅ NEW: Print Parameters
            isPrintJob,
            printMeta 
        } = req.body;
        
        // ✅ --- DEBUGGING LOGS START --- ✅
        console.log("--- ADD TO CART REQUEST RECEIVED ---");
        console.log("Type:", isPrintJob ? "PRINT JOB" : "PRODUCT");
        console.log("Request Body:", JSON.stringify(req.body, null, 2));
        // ✅ --- DEBUGGING LOGS END --- ✅

        let cart = await Cart.findOne({ user: req.user._id });
        if (!cart) {
            cart = await Cart.create({ user: req.user._id, items: [] });
        }

        // ============================================================
        // 🖨️ SCENARIO 1: PRINT JOB LOGIC
        // ============================================================
        if (isPrintJob && printMeta) {
            // Print jobs are always added as new items (we don't merge them because files might be different)
            cart.items.push({
                product: productId, // This should be the ID of your "Document Printing" service product
                qty: 1, // Usually 1 job entry (copies are inside printMeta)
                isPrintJob: true,
                printMeta: {
                    fileUrl: printMeta.fileUrl,
                    originalName: printMeta.originalName,
                    copies: printMeta.copies,
                    printType: printMeta.printType,
                    sideType: printMeta.sideType,
                    paperSize: printMeta.paperSize,
                    totalCost: printMeta.totalCost
                }
            });

            console.log("✅ SUCCESS: Print Job added to cart.");
        } 
        
        // ============================================================
        // 🛒 SCENARIO 2: STANDARD PRODUCT LOGIC (Vegetables, Clothes, etc.)
        // ============================================================
        else {
            const selectedColor = selectedVariant ? selectedVariant.color : undefined;
            const selectedSize = selectedVariant ? selectedVariant.size : undefined;

            const product = await Product.findById(productId);
            if (!product) {
                console.log(`❌ FAILED: Product with ID ${productId} not found.`);
                return res.status(404).json({ message: 'Product not found' });
            }

            // Check if item exists (Excluding Print Jobs)
            const itemIndex = cart.items.findIndex(item => 
                item.product.toString() === productId &&
                !item.isPrintJob && // Important: Don't merge with print jobs
                (item.selectedColor === selectedColor || (!item.selectedColor && !selectedColor)) &&
                (item.selectedSize === selectedSize || (!item.selectedSize && !selectedSize))
            );

            if (itemIndex > -1) {
                cart.items[itemIndex].qty += qty;
            } else {
                // --- Variant Validation ---
                const hasColorOptions = product.variants.some(v => v.color && v.color.length > 0);
                const hasSizeOptions = product.variants.some(v => v.size && v.size.length > 0);

                if ((hasColorOptions && !selectedColor) || (hasSizeOptions && !selectedSize)) {
                    let missing = [];
                    if (hasColorOptions && !selectedColor) missing.push('Color');
                    if (hasSizeOptions && !selectedSize) missing.push('Size');
                    console.log(`❌ FAILED: Missing required variants: ${missing.join(' & ')}`);
                    return res.status(400).json({ message: `Please select ${missing.join(' and ')}.` });
                }
                
                // --- Stock Check ---
                if (product.variants.length > 0) {
                    const targetVariant = product.variants.find(v => 
                        (v.color === selectedColor || (!v.color && !selectedColor)) &&
                        (v.size === selectedSize || (!v.size && !selectedSize))
                    );

                    if (!targetVariant) {
                        return res.status(400).json({ message: 'The selected variant combination is not available.' });
                    }

                    if (targetVariant.stock < qty) {
                        return res.status(400).json({ message: `Insufficient stock for selected variant.` });
                    }
                } else {
                    // No variants, check main stock
                    if (product.stock < qty) {
                        return res.status(400).json({ message: `Insufficient stock.` });
                    }
                }

                // Push new item
                cart.items.push({ 
                    product: productId, 
                    qty,
                    selectedColor: selectedColor,
                    selectedSize: selectedSize,
                    isPrintJob: false // Explicitly set false for normal items
                });
            }
        }

        await cart.save();
        console.log("✅ SUCCESS: Cart saved.");
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
    // CRITICAL FIX: Explicitly specify all required fields for population.
    const wishlist = await Wishlist.findOne({ user: req.user._id })
      .populate({
        path: 'products',
        // Ensure you select all fields needed for Product.fromJson in Flutter:
        // name, price, originalPrice, unit, images, variants, stock, seller
        select: 'name price originalPrice unit images variants stock seller'
      });
      
    if (!wishlist) {
      // Return an object with an empty products array if no document is found
      return res.json({ products: [] }); 
    }

    // Return the wishlist object (which contains the populated 'products' array).
    res.json(wishlist);
    
  } catch (err) {
    console.error('Error fetching wishlist:', err.message);
    res.status(500).json({ message: 'Error fetching wishlist', error: err.message });
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
            // यदि पहले से लाइक किया हुआ है, तो 409 दें लेकिन इसे Wishlist से हटाने की कोशिश न करें
            // (यह केवल सुनिश्चित करता है कि Wishlist में एंट्री है, यदि Flutter ने DELETE कॉल नहीं किया है)
            return res.status(409).json({ message: 'Product already liked by this user' });
        }

        // 1. Like रिकॉर्ड बनाएं (ट्रैकिंग के लिए)
        const newLike = new Like({ product: productId, user: userId });
        await newLike.save();

        // 2. 🚨 क्रिटिकल फिक्स: Product ID को यूजर के Wishlist डॉक्यूमेंट में जोड़ें
        //    $addToSet डुप्लिकेट्स को रोकता है, और upsert: true यह सुनिश्चित करता है कि 
        //    यदि Wishlist डॉक्यूमेंट मौजूद नहीं है तो यह बन जाए।
        await Wishlist.findOneAndUpdate(
            { user: userId },
            { $addToSet: { products: productId } },
            { upsert: true, new: true } 
        );

        res.status(201).json({ message: 'Product liked successfully and added to wishlist' });
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

    // 1. Cart Fetch करें (Seller Location के साथ)
    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      populate: { path: 'seller', select: 'pincodes location' }
    });

    if (!cart || cart.items.length === 0) return res.status(400).json({ message: 'Cart is empty' });

    const shippingAddress = await Address.findById(shippingAddressId);
    if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });

    // ✅ SETTINGS Fetch करें
    const appSettings = await AppSettings.findOne({ singleton: true });
    
    // ---------------------------------------------------------
    // 🚫 1. CHECK BLOCKED PINCODE (Simple & Fast)
    // ---------------------------------------------------------
    if (appSettings && appSettings.deliveryConfig && appSettings.deliveryConfig.blockedPincodes) {
        if (appSettings.deliveryConfig.blockedPincodes.includes(shippingAddress.pincode)) {
            return res.status(400).json({ 
                message: `Delivery is currently blocked for Pincode: ${shippingAddress.pincode} due to restrictions.` 
            });
        }
    }

    // ---------------------------------------------------------
    // 🚫 2. CHECK GEO-RADIUS & BLOCKED ZONES & CALCULATE FEE
    // ---------------------------------------------------------
    let maxShippingFee = 0;
    let distanceCalculated = false;

    if (shippingAddress.lat && shippingAddress.lng) {
        const userLat = parseFloat(shippingAddress.lat);
        const userLng = parseFloat(shippingAddress.lng);

        // A. Check Blocked Geo-Zones (Flood, Riots, etc.)
        if (appSettings && appSettings.deliveryConfig && appSettings.deliveryConfig.blockedZones) {
            for (const zone of appSettings.deliveryConfig.blockedZones) {
                const dist = getDistanceFromLatLonInKm(userLat, userLng, zone.lat, zone.lng);
                if (dist <= zone.radiusKm) {
                    return res.status(400).json({ message: `Delivery blocked in your area: ${zone.reason}` });
                }
            }
        }

        // B. Check Radius & Calculate Dynamic Fee
        const maxRadius = (appSettings && appSettings.deliveryConfig) ? (appSettings.deliveryConfig.globalRadiusKm || 50) : 50;
        
        for (const item of cart.items) {
            if (item.product.seller && item.product.seller.location && item.product.seller.location.coordinates) {
                const sellerLng = item.product.seller.location.coordinates[0];
                const sellerLat = item.product.seller.location.coordinates[1];
                
                const distKm = getDistanceFromLatLonInKm(userLat, userLng, sellerLat, sellerLng);

                // 1. Check Max Radius
                if (distKm > maxRadius) {
                    return res.status(400).json({
                        message: `Item "${item.product.name}" is too far (${distKm.toFixed(1)}km). We only deliver within ${maxRadius}km.`
                    });
                }

                // 2. Calculate Fee (Dynamic)
                // (Nearest = Kam Paisa, Furthest = Jyada Paisa)
                const itemFee = getDynamicDeliveryFee(distKm);
                
                // Hum max fee lenge (agar multiple seller hain to sabse dur wale ka charge lagega)
                if (itemFee > maxShippingFee) {
                    maxShippingFee = itemFee;
                }
                distanceCalculated = true;
            }
        }
    }

    // C. Fallback: Agar GPS nahi hai to Pincode based fee lagayein
    if (!distanceCalculated || maxShippingFee === 0) {
        maxShippingFee = calculateShippingFee(shippingAddress.pincode);
    }

    const shippingFee = maxShippingFee;

    // ---------------------------------------------------------
    // 💰 3. CALCULATE TOTALS (Items + Tax + Shipping - Coupon)
    // ---------------------------------------------------------
    
    // Calculate Items Total (Considering Variants)
    let totalCartAmount = 0;
    for (const item of cart.items) {
        const product = item.product;
        let price = product.price;

        // Variant Price Check
        if (product.variants && product.variants.length > 0) {
             const variant = product.variants.find(v => 
                (v.color === item.selectedColor || (!v.color && !item.selectedColor)) && 
                (v.size === item.selectedSize || (!v.size && !item.selectedSize))
            );
            if (variant) price = variant.price;
        }
        totalCartAmount += price * item.qty;
    }

    const totalTaxAmount = totalCartAmount * GST_RATE;
    let discountAmount = 0;

    // Coupon Logic
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

    // Final Total
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
      console.error("Checkout Summary Error:", err.message);
      res.status(500).json({ message: 'Error calculating summary', error: err.message });
  }
});

// ✅ UPDATED: Calculate Summary with Distance Logic & Multi-Seller Support
// ✅ UPDATED: Calculate Summary with Distance Logic & Admin Pricing Support
app.post('/api/orders/calculate-summary', protect, async (req, res) => {
  try {
    const { shippingAddressId, couponCode } = req.body; 

    // 1. Populate cart with Product AND Seller Location
    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      select: 'name variants shortDescription unit price originalPrice', 
      populate: { 
          path: 'seller', 
          select: 'pincodes location' // Fetch Seller GPS
      } 
    });

    if (!cart || cart.items.length === 0) return res.status(400).json({ message: 'Cart is empty' });

    const shippingAddress = await Address.findById(shippingAddressId);
    if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });
    
    // --- 🚚 DYNAMIC DISTANCE CALCULATION ---
    let totalShippingFee = 0;
    
    // Group items by Seller ID
    const sellersInCart = new Map();
    for (const item of cart.items) {
        if (item.product && item.product.seller) {
            const sellerId = item.product.seller._id.toString();
            if (!sellersInCart.has(sellerId)) {
                sellersInCart.set(sellerId, item.product.seller);
            }
        }
    }

    // Fetch Admin Settings for Radius & Pricing
    const appSettings = await AppSettings.findOne({ singleton: true });
    const deliveryConfig = appSettings ? appSettings.deliveryConfig : {}; 
    const maxRadius = deliveryConfig.globalRadiusKm || 50;

    // Calculate fee for each seller
    for (const seller of sellersInCart.values()) {
        let distanceCalculated = false;
        let sellerFee = 0;

        // Check if both User and Seller have GPS coordinates
        if (shippingAddress.lat && shippingAddress.lng && seller.location && seller.location.coordinates) {
            const userLat = parseFloat(shippingAddress.lat);
            const userLng = parseFloat(shippingAddress.lng);
            const sLng = seller.location.coordinates[0];
            const sLat = seller.location.coordinates[1];
            
            // Calculate Distance
            const distKm = getDistanceFromLatLonInKm(userLat, userLng, sLat, sLng);

            // Check Max Radius
            if (distKm > maxRadius) {
                return res.status(400).json({
                    message: `Seller is too far (${distKm.toFixed(1)}km). We only deliver within ${maxRadius}km.`
                });
            }

            // ✅ Pass 'deliveryConfig' so Admin rates are applied
            sellerFee = getDynamicDeliveryFee(distKm, deliveryConfig);
            distanceCalculated = true;
        }

        // Fallback: Use Pincode logic if GPS failed
        if (!distanceCalculated) {
            sellerFee = calculateShippingFee(shippingAddress.pincode);
        }

        totalShippingFee += sellerFee;
    }

    // --- CART TOTAL CALCULATION ---
    let totalCartAmount = 0;
    for (const item of cart.items) {
      
      // ✅ NEW: HANDLE PRINT JOBS
      if (item.isPrintJob && item.printMeta && item.printMeta.totalCost) {
          totalCartAmount += item.printMeta.totalCost;
          continue; // Skip standard product checks for print jobs
      }

      // --- STANDARD PRODUCT LOGIC ---
      const product = item.product;
      
      if (!product || !product.seller) continue; 

      // Variant Logic
      let selectedVariant;
      if (product.variants && product.variants.length > 0) {
          selectedVariant = product.variants.find(v => 
              (v.color === item.selectedColor || (!v.color && !item.selectedColor)) && 
              (v.size === item.selectedSize || (!v.size && !item.selectedSize))
          );
      }
      
      let price = (selectedVariant) ? selectedVariant.price : product.price;
      const stock = (selectedVariant) ? selectedVariant.stock : product.stock;

      // Check Stock
      if (stock < item.qty) {
        return res.status(400).json({ message: `Insufficient stock for product: ${product.name}` });
      }
      
      // Check Pincode Availability (Basic)
      if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
         return res.status(400).json({ message: `Delivery not available for ${product.name} at your location.` });
      }

      totalCartAmount += price * item.qty;
    }

    // --- FINANCIALS ---
    let discountAmount = 0;
    // Handle case where GST_RATE might be undefined
    const taxRate = (typeof GST_RATE !== 'undefined') ? GST_RATE : 0; 
    const totalTaxAmount = totalCartAmount * taxRate;

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

    let finalAmountForPayment = Math.max(0, totalCartAmount + totalShippingFee + totalTaxAmount - discountAmount);

    res.json({
      message: 'Summary calculated successfully.',
      itemsTotal: totalCartAmount,
      totalShippingFee: totalShippingFee,
      totalTaxAmount: totalTaxAmount,
      totalDiscount: discountAmount,
      grandTotal: finalAmountForPayment,
    });

  } catch (err) {
    console.error('POST Summary calculation error:', err.message);
    res.status(500).json({ message: 'Error calculating order summary', error: err.message });
  }
});
// ============================================================
// 📦 CREATE ORDER ENDPOINT (Full Logic)
// ============================================================

// ============================================================
// 📦 CREATE ORDER ENDPOINT (Full Integrated Logic)
// ============================================================
// ============================================================
// 📦 CREATE ORDER ENDPOINT (Full Integrated Logic)
// ============================================================
app.post('/api/orders', protect, async (req, res) => {
  try {
    const { shippingAddressId, paymentMethod, couponCode } = req.body;

    // 1. Fetch Cart with nested Seller and Product details
    const cart = await Cart.findOne({ user: req.user._id }).populate({
      path: 'items.product',
      select: 'name price originalPrice variants category seller lowStockThreshold stock unit', 
      populate: {
        path: 'seller',
        select: 'pincodes name phone fcmToken walletBalance location' 
      }
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    // 2. Fetch Admin Settings
    const appSettings = await AppSettings.findOne({ singleton: true });
    const isPrintCODAllowed = appSettings ? appSettings.allowPrintCOD : false; 
    const COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05; 

    // 3. Block COD for Print Jobs if disabled by Admin
    const hasPrintJob = cart.items.some(item => item.isPrintJob === true);
    if (hasPrintJob && (paymentMethod === 'cod' || paymentMethod === 'razorpay_cod')) {
        if (!isPrintCODAllowed) {
            return res.status(400).json({ 
                message: 'Cash on Delivery is currently disabled for Print orders. Please pay online.' 
            });
        }
    }

    const shippingAddress = await Address.findById(shippingAddressId);
    if (!shippingAddress) return res.status(404).json({ message: 'Shipping address not found' });

    // ✅ IMPROVEMENT: Format a complete label address including Name and Phone
    // This ensures the Seller sees EXACTLY who to deliver to on the PDF label.
    const labelFormattedAddress = `${shippingAddress.name}\n${shippingAddress.street}, ${shippingAddress.village || ''}\n${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}\nPhone: ${shippingAddress.phone}`;

    const ordersBySeller = new Map();
    let calculatedTotalCartAmount = 0; 

    // 4. Group Items by Seller and Validate Stock
    for (const item of cart.items) {
      const product = item.product;
      if (!product || !product.seller) {
        return res.status(400).json({ message: `Invalid product or seller in cart.` });
      }

      const sellerId = product.seller._id.toString();
      if (!ordersBySeller.has(sellerId)) {
        ordersBySeller.set(sellerId, {
          seller: product.seller,
          orderItems: [],
          totalAmount: 0,
          calculatedShippingFee: 0 
        });
      }
      const sellerOrder = ordersBySeller.get(sellerId);

      // Scenario A: Print Job Logic
      if (item.isPrintJob && item.printMeta) {
          const jobCost = Number(item.printMeta.totalCost) || 0; 
          sellerOrder.orderItems.push({
            product: product._id,
            name: item.printMeta.originalName || "Print Document",
            qty: item.qty,
            originalPrice: jobCost,
            price: jobCost,
            isPrintJob: true,
            printMeta: item.printMeta,
            category: product.category,
          });
          sellerOrder.totalAmount += jobCost;
          calculatedTotalCartAmount += jobCost;
          continue; 
      }

      // Scenario B: Standard Product Logic (Variant Aware)
      let itemPrice = product.price; 
      let itemOriginalPrice = product.originalPrice; 
      
      if (product.variants && product.variants.length > 0) {
          const selectedVariant = product.variants.find(v => 
              (v.color === item.selectedColor || (!v.color && !item.selectedColor)) && 
              (v.size === item.selectedSize || (!v.size && !item.selectedSize))
          );
          if (!selectedVariant) return res.status(400).json({ message: `Invalid variant for: ${product.name}.` });
          
          itemPrice = selectedVariant.price;
          itemOriginalPrice = selectedVariant.originalPrice;
          if (selectedVariant.stock < item.qty) return res.status(400).json({ message: `Out of stock: ${product.name}` });
      } else {
          if (product.stock < item.qty) return res.status(400).json({ message: `Out of stock: ${product.name}` });
      }

      if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
        return res.status(400).json({ message: `Delivery unavailable for: "${product.name}"` });
      }

      sellerOrder.orderItems.push({
        product: product._id,
        name: product.name,
        qty: item.qty,
        originalPrice: itemOriginalPrice,
        price: itemPrice,
        category: product.category,
        selectedColor: item.selectedColor,
        selectedSize: item.selectedSize,
        unit: product.unit || 'pcs',
        isPrintJob: false 
      });

      sellerOrder.totalAmount += itemPrice * item.qty;
      calculatedTotalCartAmount += itemPrice * item.qty;
    }
    
    // 5. Calculate Totals and Shipping
    const deliveryConfig = appSettings ? appSettings.deliveryConfig : {}; 
    let totalShippingFee = 0;
    for (const [sellerId, sellerData] of ordersBySeller.entries()) {
        let fee = (shippingAddress.lat && sellerData.seller.location?.coordinates) 
            ? getDynamicDeliveryFee(getDistanceFromLatLonInKm(shippingAddress.lat, shippingAddress.lng, sellerData.seller.location.coordinates[1], sellerData.seller.location.coordinates[0]), deliveryConfig)
            : calculateShippingFee(shippingAddress.pincode);
        sellerData.calculatedShippingFee = fee;
        totalShippingFee += fee;
    }

    const totalCartAmount = calculatedTotalCartAmount; 
    const GST_RATE_VAL = (typeof GST_RATE !== 'undefined') ? GST_RATE : 0;
    const totalTaxAmount = totalCartAmount * GST_RATE_VAL;
    
    // 6. Apply Coupon
    let discountAmount = 0;
    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode, isActive: true, expiryDate: { $gt: new Date() }, minPurchaseAmount: { $lte: totalCartAmount } });
      if (coupon) {
        discountAmount = coupon.discountType === 'percentage' 
          ? Math.min(totalCartAmount * (coupon.discountValue / 100), coupon.maxDiscountAmount || Infinity)
          : coupon.discountValue;
      }
    }
    
    const finalAmountForPayment = Math.max(0, totalCartAmount + totalShippingFee + totalTaxAmount - discountAmount);
    const effectivePaymentMethod = (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) ? 'cod' : paymentMethod;

    // 7. Razorpay Order Initiation
    let razorpayOrder = null;
    if (effectivePaymentMethod === 'razorpay') {
      razorpayOrder = await razorpay.orders.create({
        amount: Math.round(finalAmountForPayment * 100),
        currency: 'INR',
        receipt: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
      });
    }

    const createdOrders = [];

    // 8. Create Seller Sub-Orders & Commission Logic
    for (const [sellerId, sellerData] of ordersBySeller.entries()) {
      const proportion = totalCartAmount > 0 ? sellerData.totalAmount / totalCartAmount : 0; 
      const sellerDiscount = discountAmount * proportion;
      const sellerTaxAmount = totalTaxAmount * proportion;

      const isCodOrFree = effectivePaymentMethod === 'cod' || finalAmountForPayment === 0;
      const commissionAmount = parseFloat((sellerData.totalAmount * COMMISSION_RATE).toFixed(2));
      
      const sellerUser = await User.findById(sellerId);
      const balanceBefore = sellerUser.walletBalance;
      sellerUser.walletBalance -= commissionAmount; 
      await sellerUser.save();

      const order = new Order({
        user: req.user._id,
        seller: sellerData.seller,
        orderItems: sellerData.orderItems, 
        shippingAddress: labelFormattedAddress, // ✅ SAVED WITH NAME AND PHONE
        pincode: shippingAddress.pincode,
        paymentMethod: effectivePaymentMethod,
        totalAmount: parseFloat(sellerData.totalAmount.toFixed(2)), 
        taxAmount: parseFloat(sellerTaxAmount.toFixed(2)), 
        couponApplied: couponCode,
        discountAmount: parseFloat(sellerDiscount.toFixed(2)), 
        shippingFee: sellerData.calculatedShippingFee, 
        paymentId: razorpayOrder ? razorpayOrder.id : (isCodOrFree ? `cod_${crypto.randomBytes(8).toString('hex')}` : undefined),
        paymentStatus: isCodOrFree ? 'completed' : 'pending',
        deliveryStatus: isCodOrFree ? 'Pending' : 'Payment Pending',
        history: [{ status: isCodOrFree ? 'Pending' : 'Payment Pending' }]
      });
      await order.save();
      createdOrders.push(order);

      // Wallet log
      await WalletTransaction.create({
          seller: sellerId, orderId: order._id, type: 'Debit', amount: commissionAmount,
          balanceBefore, balanceAfter: sellerUser.walletBalance,
          description: `Platform Commission (Order #${order._id.toString().slice(-6)})`
      });

      // 9. Handle Post-Order Logic for COD (Stock & Notifications)
      if (isCodOrFree) {
        const orderIdShort = order._id.toString().slice(-6);
        
        // Detailed Item List (Name | Rate/Unit | Qty)
        const itemsDetail = sellerData.orderItems.map(i => 
            `- ${i.name} | ₹${i.price}/${i.unit || 'pcs'} (Qty: ${i.qty})`
        ).join('\n');

        // Variant-Aware Stock Update
        for(const item of sellerData.orderItems) {
            if (item.isPrintJob) continue;
            await Product.findOneAndUpdate(
                { _id: item.product, "variants": { $elemMatch: { color: item.selectedColor || null, size: item.selectedSize || null } } },
                { $inc: { "variants.$.stock": -item.qty, "stock": -item.qty } }
            );
        }

        // --- SELLER NOTIFICATIONS ---
        const sellerPushMsg = `New Order #${orderIdShort} from ${req.user.name}: ₹${order.totalAmount.toFixed(2)}`;
        const sellerWhatsAppMsg = `📦 *New COD Order!* (#${orderIdShort})\n\n` +
                                  `👤 *Customer:* ${req.user.name}\n` +
                                  `📞 *Contact:* ${req.user.phone}\n\n` +
                                  `🛍️ *Items:*\n${itemsDetail}\n\n` +
                                  `💵 *Collect Amount:* ₹${order.totalAmount.toFixed(2)}\n\n` +
                                  `📍 *Address:* ${shippingAddress.street}, ${shippingAddress.city}`;

        await sendWhatsApp(sellerData.seller.phone, sellerWhatsAppMsg);
        
        if (sellerData.seller.fcmToken) {
            await sendPushNotification(
                [sellerData.seller.fcmToken],
                'New COD Order! 🚚',
                sellerPushMsg,
                { orderId: order._id.toString(), type: 'NEW_ORDER' }
            );
        }

        await sendAndSavePersonalNotification(req.user._id, 'Order Placed! 🎉', `Order #${orderIdShort} placed successfully.`, { orderId: order._id.toString(), type: 'ORDER_PLACED' });

        // Delivery Assignment
        try {
            await DeliveryAssignment.create({ order: order._id, status: 'Pending', pincode: shippingAddress.pincode });
            const nearbyDeliveryBoys = await User.find({ role: 'delivery', approved: true, pincodes: shippingAddress.pincode }).select('fcmToken');
            const deliveryTokens = nearbyDeliveryBoys.map(db => db.fcmToken).filter(Boolean);
            if (deliveryTokens.length > 0) {
              await sendPushNotification(deliveryTokens, 'New Delivery Available! 🛵', `New order #${orderIdShort} in ${shippingAddress.pincode}.`, { orderId: order._id.toString(), type: 'NEW_DELIVERY_AVAILABLE' });
            }
        } catch (e) { console.error("Delivery Assignment Error:", e.message); }
      }
    }

    if (effectivePaymentMethod === 'cod') await Cart.deleteOne({ user: req.user._id }); 

    res.status(201).json({
      message: effectivePaymentMethod === 'razorpay' ? 'Order initiated.' : 'Orders created successfully',
      orders: createdOrders.map(o => o._id),
      razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount, key_id: process.env.RAZORPAY_KEY_ID } : undefined,
      grandTotal: finalAmountForPayment,
    });

  } catch (err) {
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

// ✅ UPDATED ROUTE: Get Details for E-commerce Order OR Ride Request
// ✅ KEEP THIS BLOCK (यह सही कोड है, इसे रखें)
// ✅ UPDATED ROUTE: Get Details for E-commerce Order OR Ride Request
app.get('/api/orders/:id', protect, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.user._id.toString();

    // ---------------------------------------------------------
    // 1. Check if this is a RIDE (For Village Ride Polling)
    // ---------------------------------------------------------
    // ✅ FIXED: Added 'location' to populate so Rider can track Driver
    const ride = await Ride.findById(id).populate('driver', 'name phone vehicleType location');
    
    if (ride) {
      // Security Check: Only allow the Customer, the Assigned Driver, or Admin to see details
      const isCustomer = ride.customer.toString() === userId;
      const isDriver = ride.driver && ride.driver._id.toString() === userId; // Safely check _id
      const isAdmin = req.user.role === 'admin';

      if (isCustomer || isDriver || isAdmin) {
        return res.json(ride); // Return Ride Data (contains status, otp, driver location)
      } else {
        return res.status(403).json({ message: 'Access denied to this ride.' });
      }
    }

    // ---------------------------------------------------------
    // 2. If not a Ride, check if it is an E-COMMERCE ORDER
    // ---------------------------------------------------------
    const order = await Order.findOne({ _id: id, user: userId })
      .populate({
        path: 'orderItems.product',
        select: 'name images price originalPrice unit',
      })
      .populate('seller', 'name email');

    if (order) {
      return res.json(order); // Return Order Data
    }

    // ---------------------------------------------------------
    // 3. Not found in either collection
    // ---------------------------------------------------------
    return res.status(404).json({ message: 'Order or Ride not found' });

  } catch (err) {
    console.error('Error fetching details:', err.message);
    res.status(500).json({ message: 'Error fetching details' });
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
// -------- Cancel order with auto/prepaid refund or COD manual refund --------
app.put('/api/orders/:id/cancel', protect, async (req, res) => {
  try {
    const { upiId } = req.body; // optional: user can provide UPI when cancelling COD
    
    // ✅ UPDATE: Added 'walletBalance' to populate to ensure we can update it accurately
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id })
      .populate('seller', 'phone walletBalance');

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

    // ==================================================================
    // 💰 ✅ NEW: COMMISSION REFUND LOGIC (Seller Wallet Credit)
    // ==================================================================
    try {
        // 1. Get Commission Rate
        const appSettings = await AppSettings.findOne({ singleton: true });
        const COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;

        // 2. Calculate Commission Amount to Refund
        const commissionToRefund = parseFloat((order.totalAmount * COMMISSION_RATE).toFixed(2));

        if (commissionToRefund > 0 && order.seller) {
            // Fetch seller user to ensure we are writing to the latest state
            const sellerUser = await User.findById(order.seller._id);
            
            if (sellerUser) {
                const balanceBefore = sellerUser.walletBalance;
                
                // 3. Credit Wallet
                sellerUser.walletBalance += commissionToRefund;
                await sellerUser.save();

                // 4. Log Transaction
                await WalletTransaction.create({
                    seller: sellerUser._id,
                    orderId: order._id,
                    type: 'Credit', // Money coming back
                    amount: commissionToRefund,
                    balanceBefore: balanceBefore,
                    balanceAfter: sellerUser.walletBalance,
                    description: `Commission Refund (Order Cancelled #${order._id.toString().slice(-6)})`
                });

                console.log(`✅ Refunded commission ₹${commissionToRefund} to seller ${sellerUser.name}`);
            }
        }
    } catch (commErr) {
        console.error('❌ Error refunding commission to seller:', commErr.message);
        // We do not stop the cancellation process here, just log the error
    }
    // ==================================================================

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
     // ✅ FIXED: Increase (Restore) Variant Stock AND Main Stock
for (const item of order.orderItems) {
    const productDoc = await Product.findById(item.product);

    if (productDoc && productDoc.variants && productDoc.variants.length > 0) {
        await Product.findOneAndUpdate(
            {
                _id: item.product,
                "variants": {
                    $elemMatch: {
                        color: item.selectedColor || null,
                        size: item.selectedSize || null
                    }
                }
            },
            { $inc: { "variants.$.stock": item.qty, "stock": item.qty } } // 🔺 +qty (Increase)
        );
    } else {
        await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
    }
}
    } catch (stockErr) {
      console.error('Error restoring stock after cancel:', stockErr.message || stockErr);
    }

    // ---------- Notify seller & admin ----------
    try {
      const orderIdShort = order._id.toString().slice(-6);
      if (order.seller && order.seller.phone) {
        // Updated message to mention commission refund
        await sendWhatsApp(order.seller.phone, `Order #${orderIdShort} has been cancelled by the customer. Commission has been refunded to your wallet.`);
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
// PUT /api/orders/:id/submit-upi - User submits UPI ID or Bank Details for manual refund
app.put('/api/orders/:id/submit-upi', protect, async (req, res) => {
    try {
        // Fetch all potential details from the client
        const { upiId, accountNumber, ifsc } = req.body;
        
        // 1. Validation: Ensure at least one valid method is provided
        // (UPI ID OR both Account Number and IFSC)
        if (!upiId && (!accountNumber || !ifsc)) {
            return res.status(400).json({ message: 'UPI ID or complete Bank Account/IFSC details are required for refund.' });
        }

        const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
        if (!order) return res.status(404).json({ message: 'Order not found' });

        // 2. Find the pending refund entry (status: 'requested')
        const pendingRefund = order.refunds.find(r => r.status === 'requested');
        
        if (!pendingRefund) {
             return res.status(400).json({ message: 'No active COD refund request found or details already submitted.' });
        }
        
        // 3. Update the refund entry with provided details
        if (upiId) {
            pendingRefund.upiId = upiId;
        }
        if (accountNumber && ifsc) {
            pendingRefund.bankAccountNumber = accountNumber;
            pendingRefund.ifsc = ifsc;
        }

        // 4. Construct notification and change status to 'pending'
        const notesArray = [];
        if (upiId) notesArray.push(`UPI: ${upiId}`);
        if (accountNumber && ifsc) notesArray.push(`A/C: ${accountNumber}, IFSC: ${ifsc}`);
        
        pendingRefund.notes = `Refund details submitted by user: ${notesArray.join(' / ')}`;
        pendingRefund.status = 'pending'; // Ready for admin action
        pendingRefund.updatedAt = new Date();

        order.history.push({ status: 'Refund Details Submitted', timestamp: new Date() });

        await order.save();

        await notifyAdmin(`📩 Refund Details Submitted for COD: ${notesArray.join(' / ')} (Order #${order._id.toString().slice(-6)}). Awaiting manual transfer.`);
        
        res.json({ message: 'Refund details submitted successfully. Awaiting admin approval and manual transfer.' });
    } catch (err) {
        console.error('Submit UPI/Bank Details error:', err && err.message ? err.message : err);
        res.status(500).json({ message: 'Error submitting refund details' });
    }
});



// --------- Payments Routes ----------

/**
 * Handles all logic for a successful payment.
 * @param {string} order_id - The Razorpay Order ID.
 * @param {string} payment_id - The Razorpay Payment ID.
 */
// ✅ FINAL UPDATED: handleSuccessfulPayment (With populate and unit details)
async function handleSuccessfulPayment(order_id, payment_id) {
    console.log(`Handling successful payment for Razorpay Order ID: ${order_id}`);
    
    // Sabhi pending orders fetch karein (Populate orderItems for better details)
    const orders = await Order.find({ paymentId: order_id, paymentStatus: 'pending' });

    if (!orders || orders.length === 0) {
        console.log(`No pending orders found for Razorpay Order ID: ${order_id}.`);
        return;
    }
    
    const paymentHistoryEntries = [];
    let customerId = orders[0].user;
    
    // Customer details pehle hi fetch kar lein seller notification mein naam dikhane ke liye
    const customerInfo = await User.findById(customerId).select('name phone fcmToken');

    for (const order of orders) {
        // --- STEP 1: Update Order Status ---
        order.paymentStatus = 'completed';
        order.deliveryStatus = 'Pending';
        order.history.push({ 
            status: 'Payment Completed', 
            note: 'Razorpay verification successful.' 
        });
        order.paymentId = payment_id;
        await order.save();

        // --- STEP 2: Detailed Seller Notification ---
        // Items detail with Rate and Unit (agar available ho)
        const itemsDetail = order.orderItems.map(item => 
            `- ${item.name} | ₹${item.price}/${item.unit || 'pcs'} (Qty: ${item.qty})`
        ).join('\n');

        const seller = await User.findById(order.seller).select('phone fcmToken name');
        
        const sellerMessage = `🎉 *New Paid Order!* (#${order._id.toString().slice(-6)})\n\n` +
                              `👤 *Customer:* ${customerInfo?.name || 'Customer'}\n` +
                              `📞 *Contact:* ${customerInfo?.phone || 'N/A'}\n\n` +
                              `📦 *Items:*\n${itemsDetail}\n\n` +
                              `💰 *Total Amount:* ₹${order.totalAmount.toFixed(2)}\n` +
                              `📍 *Pincode:* ${order.pincode}\n\n` +
                              `Kripya dashboard mein order process karein.`;

        // Notification to Seller
        if (seller) {
            await sendWhatsApp(seller.phone, sellerMessage);
            if (seller.fcmToken) {
                await sendPushNotification(
                    [seller.fcmToken],
                    'New Paid Order! 🛍️',
                    `Order from ${customerInfo?.name || 'User'} for ₹${order.totalAmount.toFixed(2)}`,
                    { orderId: order._id.toString(), type: 'NEW_ORDER' }
                );
            }
        }

        // --- STEP 3: Deduct Stock (Variant Aware) ---
        for (const item of order.orderItems) {
            if (item.isPrintJob) continue; // Print jobs ka stock nahi hota

            const productDoc = await Product.findById(item.product);

            if (productDoc && productDoc.variants && productDoc.variants.length > 0) {
                await Product.findOneAndUpdate(
                    {
                        _id: item.product,
                        "variants": {
                            $elemMatch: {
                                color: item.selectedColor || null,
                                size: item.selectedSize || null
                            }
                        }
                    },
                    { $inc: { "variants.$.stock": -item.qty, "stock": -item.qty } }
                );
            } else {
                await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
            }
        }

        // --- STEP 4: Create Delivery Assignment ---
        try {
            const orderPincode = order.pincode;
            await DeliveryAssignment.create({
                order: order._id,
                deliveryBoy: null,
                status: 'Pending',
                pincode: orderPincode,
                history: [{ status: 'Pending' }]
            });

            // Nearby Delivery Boys Notification
            const nearbyDeliveryBoys = await User.find({ 
                role: 'delivery', 
                approved: true, 
                pincodes: orderPincode 
            }).select('fcmToken');
            
            const deliveryTokens = nearbyDeliveryBoys.map(db => db.fcmToken).filter(Boolean);
            
            if (deliveryTokens.length > 0) {
                await sendPushNotification(
                    deliveryTokens,
                    'New Delivery Available! 🛵',
                    `New paid order in ${orderPincode}. Open app to accept.`,
                    { orderId: order._id.toString(), type: 'NEW_DELIVERY_AVAILABLE' }
                );
            }
        } catch (deliveryErr) {
            console.error('Delivery Error:', deliveryErr.message);
        }

        // --- STEP 5: Payment History ---
        paymentHistoryEntries.push({
            user: customerId,
            order: order._id,
            razorpayOrderId: order_id,
            razorpayPaymentId: payment_id,
            amount: order.totalAmount,
            status: 'completed',
        });
    }
    
    await PaymentHistory.insertMany(paymentHistoryEntries);
    
    // --- STEP 6: Clear Cart ---
    await Cart.deleteOne({ user: customerId });
    
    // --- STEP 7: Final Customer Confirmation ---
    if (customerInfo) {
        const customerMsg = `✅ Your payment has been confirmed and your order is being processed! Thank you, ${customerInfo.name}!`;
        await sendWhatsApp(customerInfo.phone, customerMsg);
        if (customerInfo.fcmToken) {
            await sendPushNotification(
                [customerInfo.fcmToken], 
                'Payment Confirmed! ✅', 
                `Your order #${orders[0]._id.toString().slice(-6)} is being processed!`,
                { type: 'ORDER_UPDATE' }
            );
        }
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
    const { order_id, payment_id, signature, printJobId } = req.body; // printJobId यहाँ ज़रूरी है
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${order_id}|${payment_id}`);
    const digest = shasum.digest('hex');

    if (digest === signature) {
      
      // 1. अगर यह "प्रिंट सर्विस" का पेमेंट है
      if (printJobId) {
        const printJob = await PrintJob.findByIdAndUpdate(
          printJobId, 
          { paymentStatus: 'completed' }, 
          { new: true }
        );

        if (printJob) {
          // सेलर के वॉलेट में कमीशन काटकर पैसा जमा करें
          await sellerCreditForPrint(printJob); 
        }
        
        return res.json({ status: 'success', message: 'Print payment verified and seller credited' });
      }

      // 2. अगर यह सामान्य "Product Order" का पेमेंट है
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

// --------------------------------------------------------------------------------
// --------- ADDRESS ROUTES (User: Add, Edit, Delete, Get) ----------
// --------------------------------------------------------------------------------

// 1. Get All Addresses
app.get('/api/addresses', protect, async (req, res) => {
  try {
    // Sort by isDefault (-1 puts true first) so default address shows at top
    const addresses = await Address.find({ user: req.user._id }).sort({ isDefault: -1 });
    res.json(addresses);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching addresses', error: err.message });
  }
});

// 2. Add New Address
// 2. Add New Address (Updated to save Lat/Lng)
app.post('/api/addresses', protect, async (req, res) => {
  try {
    // ✅ Extract lat and lng from req.body along with other fields
    const { 
        name, street, village, landmark, city, state, pincode, phone, isDefault, 
        lat, lng // <--- Added these
    } = req.body;

    // Check if this is the user's first address. If so, make it default automatically.
    const addressCount = await Address.countDocuments({ user: req.user._id });
    let shouldBeDefault = isDefault === true;
    if (addressCount === 0) {
        shouldBeDefault = true;
    }

    // If this new address is set to default, unset previous default
    if (shouldBeDefault) {
      await Address.updateMany({ user: req.user._id }, { isDefault: false });
    }

    const newAddress = await Address.create({
      user: req.user._id,
      name, 
      street, 
      village, 
      landmark, 
      city, 
      state, 
      pincode, 
      phone,
      // ✅ Save coordinates to database
      lat,
      lng,
      isDefault: shouldBeDefault
    });
    
    res.status(201).json(newAddress);
  } catch (err) {
    console.error("Add Address Error:", err.message);
    res.status(500).json({ message: 'Error adding address', error: err.message });
  }
});

// 3. Edit Address
app.put('/api/addresses/:id', protect, async (req, res) => {
  try {
    const { name, street, village, landmark, city, state, pincode, phone, isDefault } = req.body;
    
    // Find address and ensure it belongs to the logged-in user
    const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
    if (!address) {
        return res.status(404).json({ message: 'Address not found or you do not have permission' });
    }

    // If setting as default, unset all other addresses for this user first
    if (isDefault === true) {
      await Address.updateMany({ user: req.user._id }, { isDefault: false });
    }

    // Update fields if provided
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
    console.error("Edit Address Error:", err.message);
    res.status(500).json({ message: 'Error updating address', error: err.message });
  }
});

// 4. Delete Address
app.delete('/api/addresses/:id', protect, async (req, res) => {
  try {
    // Find address ensuring it belongs to the user (security check)
    // REMOVED authorizeRole('admin') so users can delete their own
    const address = await Address.findOne({ _id: req.params.id, user: req.user._id });
    
    if (!address) {
        return res.status(404).json({ message: 'Address not found or you do not have permission' });
    }

    await address.deleteOne();
    res.json({ message: 'Address deleted successfully' });
  } catch (err) {
    console.error("Delete Address Error:", err.message);
    res.status(500).json({ message: 'Error deleting address', error: err.message });
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

// --- Updated Product Upload Route with Wallet Logic ---

app.post('/api/seller/products',
  protect,
  authorizeRole('seller', 'admin'),
  checkSellerApproved,
  productUpload, // Handles multiple uploads
  async (req, res) => {
    
    // 1️⃣ Start a Database Session (Transaction)
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        productTitle, brand, category, subcategory, childCategory,
        shortDescription, fullDescription, unit,
        variants, // JSON string
        videoLink, specifications, shippingWeight, shippingLength,
        shippingWidth, shippingHeight, shippingType, warranty,
        returnPolicy, tags, serviceDurationMinutes,
        pincodeList, // JSON string
        isGlobal,    // string 'true'/'false'
        
        // ✅ [ADDED BACK] Fields for Vegetable/Fruit Sellers
        dailyPriceUpdate, 
        lowStockThreshold
      } = req.body;

      const sellerId = req.user._id;

      // ============================================================
      // 💰 WALLET & LIMIT CHECK LOGIC (START)
      // ============================================================
      
      const currentProductCount = await Product.countDocuments({ seller: sellerId });
      const settings = await AppSettings.findOne({ singleton: true }).session(session);
      const PRODUCT_FEE = settings ? settings.productCreationFee : 10; // Default ₹10
      const FREE_LIMIT = 20;
      let feeDeducted = false;

      // If seller has crossed the free limit
      if (currentProductCount >= FREE_LIMIT) {
          // Fetch fresh user data with session to ensure atomic read
          const seller = await User.findById(sellerId).session(session);

          // Check Balance
          if (seller.walletBalance < PRODUCT_FEE) {
              await session.abortTransaction();
              session.endSession();
              return res.status(400).json({ 
                  message: `Free limit (20 products) reached. Insufficient wallet balance to add more. Fee: ₹${PRODUCT_FEE}. Please recharge.` 
              });
          }

          // Deduct Fee
          const balanceBefore = seller.walletBalance;
          seller.walletBalance -= PRODUCT_FEE;
          await seller.save({ session });

          // Log Transaction
          await WalletTransaction.create([{
              seller: sellerId,
              type: 'Debit',
              amount: PRODUCT_FEE,
              balanceBefore: balanceBefore,
              balanceAfter: seller.walletBalance,
              description: `Fee for adding product: ${productTitle}`
          }], { session });

          feeDeducted = true;
      }
      // ============================================================
      // 💰 WALLET LOGIC (END)
      // ============================================================


      // --- 2. Basic Validation ---
      if (!productTitle || !category || !variants) {
        throw new Error('Product title, category, and variants are required.');
      }

      // --- 3. Category Validation ---
      const parentCategory = await Category.findById(category).session(session);
      if (!parentCategory) {
        throw new Error('Selected category not found.');
      }
      if (parentCategory.type === 'service' && (!serviceDurationMinutes || parseInt(serviceDurationMinutes) <= 0)) {
        throw new Error('Services must have a valid "Service Duration".');
      } else if (parentCategory.type === 'product' && !unit) {
        throw new Error('Products must have a "Unit".');
      }
      if (!req.files.images || req.files.images.length === 0) {
        throw new Error('At least one main product image is required.');
      }

      // --- 4. Process Files ---
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

      // --- 5. Parse Variants ---
      const parsedVariants = JSON.parse(variants);
      if (!Array.isArray(parsedVariants) || parsedVariants.length === 0) {
        throw new Error('At least one product variant is required.');
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
          costPrice: variant.costPrice ? parseFloat(variant.costPrice) : null,
          stock: parseInt(variant.stock),
          images: variantImages[index] ? [variantImages[index]] : []
        };
      });

      const firstVariant = productVariants[0];
      const totalStock = productVariants.reduce((sum, v) => sum + v.stock, 0);

      // --- 6. Pincodes & Global Flag ---
      let finalPincodes = req.user.pincodes || [];
      if (pincodeList) {
          try {
              const parsedPincodes = JSON.parse(pincodeList);
              if (Array.isArray(parsedPincodes)) {
                  finalPincodes = parsedPincodes.filter(p => typeof p === 'string' && p.length > 0);
              }
          } catch (e) {
              console.warn('Pincode parsing error, using default.', e);
              finalPincodes = req.user.pincodes || []; 
          }
      }
      const isProductGlobal = isGlobal === 'true';

      // ✅ NEW: Determine Approval Status based on Role
      // Admin = Approved (true), Seller = Pending (false)
      const isApprovedStatus = req.user.role === 'admin' ? true : false;

      // --- 7. Prepare Data ---
      const finalSubcategory = childCategory || subcategory;
      const productData = {
        name: productTitle,
        sku: generateUniqueSku(category, productTitle),
        brand,
        category,
        subcategory: finalSubcategory,
        price: firstVariant.price,
        originalPrice: firstVariant.originalPrice,
        stock: totalStock,
        unit: parentCategory.type === 'product' ? unit : undefined,
        shortDescription,
        fullDescription,
        images: mainImages,
        uploadedVideo,
        videoLink,
        variants: productVariants,
        seller: req.user._id,
        pincodes: finalPincodes, 
        isGlobal: isProductGlobal,
        
        // ✅ SAVE APPROVAL STATUS
        isApproved: isApprovedStatus, 
        
        // ✅ [ADDED BACK] Daily Update & Low Stock Logic
        dailyPriceUpdate: dailyPriceUpdate === 'true', 
        lowStockThreshold: lowStockThreshold ? parseInt(lowStockThreshold) : 5,

        serviceDurationMinutes: parentCategory.type === 'service' ? parseInt(serviceDurationMinutes) : undefined,
        specifications: specifications ? JSON.parse(specifications) : {},
        shippingDetails: { 
            weight: shippingWeight ? parseFloat(shippingWeight) : undefined,
            dimensions: {
                length: shippingLength ? parseFloat(shippingLength) : undefined,
                width: shippingWidth ? parseFloat(shippingWidth) : undefined,
                height: shippingHeight ? parseFloat(shippingHeight) : undefined,
            },
            shippingType: shippingType || 'Free',
        },
        otherInformation: {
          tags: tags ? JSON.parse(tags) : [],
          warranty: warranty || null,
          returnPolicy: returnPolicy || 'Non-Returnable',
        },
      };

      // --- 8. Create Product (WITH SESSION) ---
      // Note: Model.create([data], { session }) returns an array
      const createdProducts = await Product.create([productData], { session });
      const product = createdProducts[0];

      // ✅ Commit the transaction (Save money deduction + Product)
      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
          message: feeDeducted 
            ? `Product added successfully. ₹${PRODUCT_FEE} deducted from wallet.` 
            : 'Product added successfully (Free Slot).',
          product
      });

    } catch (err) {
      // ❌ If anything fails, Abort transaction (Refund money if deducted, don't save product)
      await session.abortTransaction();
      session.endSession();
      
      console.error('Create product error:', err);
      
      if (err.name === 'ValidationError' || err.message.includes('must have a price') || err.message.includes('MRP')) {
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
      variants, imagesToDelete,
      
      // ✨ [NEW]: Fields for updating pincode and global setting
      pincodeList, // Expected: JSON string of a string array, e.g., '["800001", "800002"]'
      isGlobal,    // Expected: string 'true' or 'false'

      // ✅ [ADDED]: Fields for Vegetable/Fruit Sellers (Daily Updates & Alerts)
      dailyPriceUpdate, 
      lowStockThreshold

    } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // --- Access Control ---
    if (req.user.role === 'seller' && product.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied: You do not own this product' });
    }
    
    // --- 1. Image Deletion (Main Images) ---
    if (imagesToDelete) {
      const idsToDelete = Array.isArray(imagesToDelete) ? idsToDelete : [imagesToDelete];
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
                costPrice: variant.costPrice ? parseFloat(variant.costPrice) : null,
                stock: variantStock,
                images: variantImagesData 
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
    
    // --- 4. Update Pincodes and Global Flag (NEW LOGIC) ---
    if (typeof isGlobal !== 'undefined') {
        product.isGlobal = isGlobal === 'true'; // Convert string 'true'/'false' to boolean
    }

    if (pincodeList) {
        try {
            const parsedPincodes = JSON.parse(pincodeList);
            if (Array.isArray(parsedPincodes)) {
                product.pincodes = parsedPincodes.filter(p => typeof p === 'string' && p.length > 0);
            }
        } catch (e) {
            console.warn('PincodeList parsing failed during PUT. Skipping pincode update.', e);
        }
    }

    // --- 5. Update Scalar Fields ---
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

    // ✅ [ADDED]: Update Logic for Daily Price & Low Stock
    if (typeof dailyPriceUpdate !== 'undefined') {
        product.dailyPriceUpdate = dailyPriceUpdate === 'true';
    }
    if (lowStockThreshold) {
        product.lowStockThreshold = parseInt(lowStockThreshold);
    }

    const finalSubcategory = childCategory || subcategory;
    if (finalSubcategory) product.subcategory = finalSubcategory;

    // Update derived fields
    product.price = defaultPrice;
    product.originalPrice = defaultOriginalPrice;
    product.stock = totalStock;

    // Update shipping details
    if (shippingWeight) product.shippingDetails.weight = parseFloat(shippingWeight);
    if (shippingLength) product.shippingDetails.dimensions.length = parseFloat(shippingLength);
    if (shippingWidth) product.shippingDetails.dimensions.width = parseFloat(shippingWidth);
    if (shippingHeight) product.shippingDetails.dimensions.height = parseFloat(shippingHeight);
    if (shippingType) product.shippingDetails.shippingType = shippingType;

    
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

// ✅ NEW CRON JOB: Daily Price Update Reminder (Runs daily at 7:00 AM)
cron.schedule('0 7 * * *', async () => {
  console.log('⏰ Running Daily Price Update Reminder...');
  
  try {
    // 1. Find all products marked for daily update
    // We only need the seller IDs, so we group by seller
    const productsNeedingUpdate = await Product.find({ dailyPriceUpdate: true, stock: { $gt: 0 } })
        .populate('seller', 'fcmToken name phone');

    // 2. Extract Unique Sellers (taaki ek seller ko 10 bar msg na jaye)
    const sellerMap = new Map();
    
    productsNeedingUpdate.forEach(p => {
        if (p.seller && !sellerMap.has(p.seller._id.toString())) {
            sellerMap.set(p.seller._id.toString(), p.seller);
        }
    });

    // 3. Send Notifications
    for (const seller of sellerMap.values()) {
        const msg = `Good Morning ${seller.name}! ☀️\nPlease update your Vegetable/Fruit prices for today to ensure correct orders.`;

        // Send WhatsApp
        if (seller.phone) {
            await sendWhatsApp(seller.phone, `🥦 *Daily Price Update*\n\n${msg}`);
        }

        // Send Push Notification
        if (seller.fcmToken) {
            await sendPushNotification(
                [seller.fcmToken],
                'Update Prices Today 📝',
                'Market rates change daily! Tap to update your product prices now.',
                { type: 'DAILY_PRICE_UPDATE' }
            );
        }
    }
    
    console.log(`✅ Daily reminders sent to ${sellerMap.size} sellers.`);

  } catch (err) {
    console.error('❌ Daily Price Cron Failed:', err.message);
  }
});

// ✅ GET ALERTS API (For Seller Dashboard Pop-up)
app.get('/api/seller/alerts', protect, authorizeRole('seller'), async (req, res) => {
    try {
        // Find products with low stock
        // Logic: stock <= lowStockThreshold
        const lowStockProducts = await Product.find({
            seller: req.user._id,
            $expr: { $lte: ["$stock", "$lowStockThreshold"] } // Compare fields
        }).select('name stock lowStockThreshold images');

        // Find products needing daily update (Optional logic: You can verify last updated date)
        const dailyUpdateProducts = await Product.find({
            seller: req.user._id,
            dailyPriceUpdate: true
        }).select('name price updatedAt');

        // Filter daily products that haven't been updated TODAY
        const startOfToday = new Date();
        startOfToday.setHours(0,0,0,0);
        
        const pendingDailyUpdates = dailyUpdateProducts.filter(p => {
            return new Date(p.updatedAt) < startOfToday;
        });

        res.json({
            lowStock: lowStockProducts,
            pendingUpdates: pendingDailyUpdates,
            totalAlerts: lowStockProducts.length + pendingDailyUpdates.length
        });

    } catch (err) {
        res.status(500).json({ message: 'Error fetching alerts' });
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
    // UPDATED: We no longer strictly need to populate 'user' for the 'SHIP TO' section 
    // because the specific delivery name and address are stored in order.shippingAddress
    const order = await Order.findById(req.params.id).populate('user', 'name phone');
    
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied to this order' });
    }

    const sellerAddress = req.user.pickupAddress;
    if (!sellerAddress || !sellerAddress.isSet || !sellerAddress.pincode) {
      return res.status(400).json({ message: 'Seller pickup address is not set. Please update profile.' });
    }

    // The order.shippingAddress field should contain the full formatted string 
    // including the Name and Phone Number captured at the time of order.
    const customerFullDetails = order.shippingAddress;
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

    // Header Details
    doc.fontSize(14).font('Helvetica-Bold').text(`Order: #${orderId.slice(-8)}`, { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(`Payment: ${order.paymentMethod.toUpperCase()}`, { align: 'center' });

    if (order.paymentMethod === 'cod' || order.paymentMethod === 'razorpay_cod') {
      doc.fontSize(12).font('Helvetica-Bold').text(`Amount Due: ₹${finalAmount.toFixed(2)}`, { align: 'center' });
    }
    doc.moveDown(1);

    // SHIP FROM (Seller Details)
    doc.fontSize(10).font('Helvetica-Bold').text('SHIP FROM:');
    doc.fontSize(10).font('Helvetica').text(req.user.name);
    doc.text(sellerAddress.street);
    if (sellerAddress.landmark) doc.text(`Landmark: ${sellerAddress.landmark}`);
    if (sellerAddress.village) doc.text(`Village: ${sellerAddress.village}`);
    doc.text(`${sellerAddress.city}, ${sellerAddress.state} - ${sellerAddress.pincode}`);
    doc.text(`Phone: ${req.user.phone}`);

    doc.moveDown(2);

    // SHIP TO (User Delivery Details)
    // UPDATED: Printing the exact delivery data provided by the user during checkout
    doc.rect(15, 170, 258, 120).stroke();
    doc.fontSize(12).font('Helvetica-Bold').text('SHIP TO:', 20, 175);
    
    // We print the stored shippingAddress string which contains the user's 
    // chosen delivery name, phone, and address details.
    doc.fontSize(11).font('Helvetica').text(customerFullDetails, 20, 195, { 
        width: 248,
        align: 'left'
    });

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
      status: { $in: ['Pending', 'ReturnPending'] }, // 👈 FIX: Added 'ReturnPending'
      pincode: { $in: myPincodes }
    })
    .populate({
      path: 'order',
      select: 'orderItems shippingAddress totalAmount paymentMethod seller user shippingFee discountAmount taxAmount createdAt', // Added createdAt for sorting
      populate: [
        { path: 'seller', select: 'name pickupAddress' },
        { path: 'user', select: 'name phone' }
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
      status: { $in: ['Accepted', 'PickedUp', 'ReturnAccepted', 'ReturnPickedUp'] } // 👈 FIX: Added Return statuses
    })
    .populate({
      path: 'order',
      select: 'orderItems shippingAddress totalAmount paymentMethod seller user shippingFee discountAmount taxAmount createdAt', // Added createdAt
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

    // --- 1. Determine the assignment type and the next status ---
    const updateQuery = {
        _id: assignmentId,
        deliveryBoy: null,
        // FIX: Allow acceptance of both Delivery ('Pending') and Return Pickup ('ReturnPending')
        status: { $in: ['Pending', 'ReturnPending'] } 
    };
    
    // Find the assignment first to check its current status
    const assignmentToUpdate = await DeliveryAssignment.findOne(updateQuery);
    if (!assignmentToUpdate) {
        return res.status(409).json({ message: 'This assignment has already been accepted by someone else or is not pending.' });
    }
    
    // Determine the new status based on the current status
    const isReturnFlow = assignmentToUpdate.status === 'ReturnPending';
    const newStatus = isReturnFlow ? 'ReturnAccepted' : 'Accepted';
    
    // --- 2. Atomically update the assignment with the new status ---
    const assignment = await DeliveryAssignment.findOneAndUpdate(
      updateQuery, // Use the query that checks for null/Pending status
      {
        $set: {
          deliveryBoy: req.user._id,
          status: newStatus // 👈 FIXED: Setting dynamic status
        },
        $push: { history: { status: newStatus } }
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
      return res.status(409).json({ message: 'This assignment has just been accepted by someone else or is not pending.' });
    }

    const orderIdShort = assignment.order._id.toString().slice(-6);
    
    // --- 3. Notification Logic (Dynamic Messages) ---

    const messageType = isReturnFlow ? 'Return Pickup Accepted' : 'Order Accepted';
    const sellerMessage = isReturnFlow 
        ? `Return Update: Delivery boy ${req.user.name} accepted return pickup for #${orderIdShort}.`
        : `Order Update: Delivery boy ${req.user.name} is on the way to pick up order #${orderIdShort}.`;
        
    const customerMessage = isReturnFlow
        ? `Your return pickup for #${orderIdShort} has been accepted by ${req.user.name}.`
        : `Your order #${orderIdShort} is being prepared! Delivery partner ${req.user.name} has accepted it.`;


    const seller = assignment.order.seller;
    if (seller) {
      await sendWhatsApp(seller.phone, sellerMessage);
      await sendPushNotification(
        seller.fcmToken,
        messageType,
        sellerMessage,
        { orderId: assignment.order._id.toString(), type: 'DELIVERY_ASSIGNED' }
      );
    }
    
    const customer = assignment.order.user;
    if (customer) {
        await sendWhatsApp(customer.phone, customerMessage);
        await sendPushNotification(
          customer.fcmToken,
          messageType,
          customerMessage,
          { orderId: assignment.order._id.toString(), type: 'ORDER_STATUS' }
        );
    }

    res.json({ message: `Assignment accepted successfully! Status: ${newStatus}`, assignment });

  } catch (err) {
    console.error('Error accepting assignment:', err.message);
    res.status(500).json({ message: 'Error accepting assignment', error: err.message });
  }
});

app.put('/api/delivery/assignments/:id/status', protect, authorizeRole('delivery'), async (req, res) => {
  try {
    const { status } = req.body;
    const assignmentId = req.params.id;

    const validStatuses = ['PickedUp', 'Delivered', 'Cancelled', 'ReturnAccepted', 'ReturnPickedUp', 'ReturnDelivered', 'ReturnCancelled'];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }

    const assignment = await DeliveryAssignment.findOne({
      _id: assignmentId,
      deliveryBoy: req.user._id
    });

    if (!assignment) {
      return res.status(404).json({ message: 'Delivery assignment not found or you are not authorized.' });
    }

    let newOrderStatus = '';
    let newAssignmentStatus = status;
    let notificationTitle = '';
    let notificationBody = '';
    let isReturnFlow = assignment.status.toLowerCase().includes('return');
    let allowTransition = false;


    // --- 1. Check Valid Transitions ---

    if (status === 'PickedUp' && assignment.status === 'Accepted') {
      newOrderStatus = 'Shipped';
      notificationTitle = 'Order Picked Up!';
      notificationBody = `Your order (#${assignment.order.toString().slice(-6)}) is on its way!`;
      allowTransition = true;
    } else if (status === 'Delivered' && assignment.status === 'PickedUp') {
      newOrderStatus = 'Delivered';
      notificationTitle = 'Order Delivered! 🎉';
      notificationBody = `Your order (#${assignment.order.toString().slice(-6)}) has been successfully delivered. Thank you!`;
      allowTransition = true;
    } else if (status === 'ReturnPickedUp' && assignment.status === 'ReturnAccepted') {
      newOrderStatus = 'Return In Transit';
      notificationTitle = 'Return Picked Up!';
      notificationBody = `Your return package (#${assignment.order.toString().slice(-6)}) has been picked up.`;
      allowTransition = true;
    } else if (status === 'ReturnDelivered' && assignment.status === 'ReturnPickedUp') {
      newOrderStatus = 'Return Completed';
      notificationTitle = 'Return Completed';
      notificationBody = `Your return package (#${assignment.order.toString().slice(-6)}) has been delivered back to the seller.`;
      allowTransition = true;
    } else if (status.includes('Cancelled')) {
        newAssignmentStatus = status;
        newOrderStatus = 'Cancelled';
        notificationTitle = 'Order Cancelled';
        notificationBody = `The assignment for order (#${assignment.order.toString().slice(-6)}) has been cancelled.`;
        allowTransition = true;
    }
    
    if (!allowTransition) {
        return res.status(400).json({ message: `Invalid status transition from ${assignment.status} to ${status}.` });
    }

    // --- 2. Apply Status Changes ---
    
    assignment.status = newAssignmentStatus;
    assignment.history.push({ status: newAssignmentStatus });
    await assignment.save();

    const order = await Order.findById(assignment.order).populate('user', 'phone fcmToken');
    if (!order) {
        return res.status(404).json({ message: 'Associated order not found.' });
    }

    order.deliveryStatus = newOrderStatus;
    order.history.push({ status: newOrderStatus, note: `Updated by Delivery Boy ${req.user.name}` });

    // Handle payment completion for COD on successful delivery
    if (newOrderStatus === 'Delivered' && (order.paymentMethod === 'cod' || order.paymentMethod === 'razorpay_cod') && order.paymentStatus === 'pending') {
      order.paymentStatus = 'completed';
    }
    
    // Handle stock restore on return completion (VARIANT AWARE FIX)
    if (newOrderStatus === 'Return Completed') {
        // Find the original item in the return list (refunds array)
        const returnRefundEntry = order.refunds.find(r => r.status === 'requested');
        
        if (returnRefundEntry) {
            // ✅ Restore stock for all items (Variant + Main)
            for (const item of order.orderItems) {
                const productDoc = await Product.findById(item.product);
                
                if (productDoc && productDoc.variants && productDoc.variants.length > 0) {
                    await Product.findOneAndUpdate(
                        {
                            _id: item.product,
                            "variants": { 
                                $elemMatch: { 
                                    color: item.selectedColor || null, 
                                    size: item.selectedSize || null 
                                } 
                            }
                        },
                        { $inc: { "variants.$.stock": item.qty, "stock": item.qty } } // Increase both
                    );
                } else {
                    await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
                }
            }
            
            // Mark the refund request as completed/resolved
            returnRefundEntry.status = 'approved';
            returnRefundEntry.updatedAt = new Date();
            
            // Notify admin to process the customer refund
            await notifyAdmin(`📦 Return Completed (Order #${order._id.toString().slice(-6)}). Admin needs to process refund for customer.`);
        }
    }
    
    // Handle cancellations (VARIANT AWARE FIX)
    if (newOrderStatus === 'Cancelled') {
        // Stock only needs restoration if cancelled after pickup, and only for delivery flow.
        if (!isReturnFlow && order.paymentStatus !== 'failed' && order.deliveryStatus !== 'Payment Pending') {
             for (const item of order.orderItems) {
                const productDoc = await Product.findById(item.product);
                
                if (productDoc && productDoc.variants && productDoc.variants.length > 0) {
                    await Product.findOneAndUpdate(
                        {
                            _id: item.product,
                            "variants": { 
                                $elemMatch: { 
                                    color: item.selectedColor || null, 
                                    size: item.selectedSize || null 
                                } 
                            }
                        },
                        { $inc: { "variants.$.stock": item.qty, "stock": item.qty } }
                    );
                } else {
                    await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
                }
            }
        }
    }

    await order.save();

    // --- 3. Notifications ---
    const customer = order.user;
    if (customer) {
        await sendWhatsApp(customer.phone, `${notificationTitle}\n${notificationBody}`);
        await sendPushNotification(
            customer.fcmToken,
            notificationTitle,
            notificationBody,
            { orderId: order._id.toString(), type: 'ORDER_STATUS' }
        );
    }
    
    res.json({ message: `Assignment status updated to ${newAssignmentStatus}`, assignment });

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

// [NEW ADMIN ROUTE] - Admin approves customer return request and creates delivery assignment
// [CORRECTED ADMIN ROUTE] - Admin approves customer return request and updates existing assignment
app.post('/api/admin/orders/:id/approve-return', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const orderId = req.params.id;
        // Populate seller details to check if they have a phone/fcmToken
        const order = await Order.findById(orderId).populate('user', 'phone fcmToken').populate('seller', 'fcmToken phone');
        
        if (!order || order.deliveryStatus !== 'Return Requested') {
            return res.status(400).json({ message: 'Order is not in Return Requested status.' });
        }

        // 1. Update Order Status
        order.deliveryStatus = 'Return Accepted by Admin';
        order.history.push({ status: 'Return Accepted by Admin' });
        await order.save();

        // 2. FIND AND UPDATE THE EXISTING Delivery Assignment for Return Pickup
        // CRITICAL FIX: Use findOneAndUpdate to prevent E11000 duplicate key errors
        const newAssignmentStatus = 'ReturnPending';
        
        const assignment = await DeliveryAssignment.findOneAndUpdate(
            { order: order._id }, // ⬅️ यह मौजूदा असाइनमेंट को ऑर्डर ID से ढूंढ़ता है
            {
                $set: {
                    deliveryBoy: null, // इसे पूल के लिए असाइन न किया गया सेट करें
                    status: newAssignmentStatus, // रिटर्न पिकअप के लिए स्थिति सेट करें
                },
                $push: { history: { status: newAssignmentStatus } }
            },
            { new: true, upsert: true } // Upsert: true इसे नहीं मिलने पर बनाएगा (जो एक सुरक्षित फ़ॉलबैक है)
        );

        // 3. Notify Delivery Boys 
        const nearbyDeliveryBoys = await User.find({
          role: 'delivery', approved: true, pincodes: order.pincode
        }).select('fcmToken');
        const deliveryTokens = nearbyDeliveryBoys.map(db => db.fcmToken).filter(Boolean);

        if (deliveryTokens.length > 0) {
          await sendPushNotification(
              deliveryTokens,
              'New Return Pickup Available! 📦',
              `A new return pickup (#${orderId.slice(-6)}) is available in Pincode: ${order.pincode}.`,
              { orderId: order._id.toString(), type: 'NEW_RETURN_AVAILABLE' }
          );
        }
        
        // 4. Notify Customer
        await sendWhatsApp(order.user.phone, `✅ Your return request for order #${orderId.slice(-6)} has been approved. A delivery partner will be assigned for pickup shortly.`);

        // 5. Notify Seller (Optional, but good practice)
        if (order.seller) {
            await sendWhatsApp(order.seller.phone, `🔔 Return Approved: Admin accepted the return request for order #${orderId.slice(-6)}. A delivery boy will pick up the item soon.`);
        }


        res.json({ message: 'Return approved and assigned for pickup.', assignment });

    } catch (err) {
        console.error('Error approving return and processing assignment:', err.message);
        res.status(500).json({ message: 'Error processing return approval.' });
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
    
    // Populate user to get ID and Phone
    const order = await Order.findById(req.params.id).populate('user');
    
    if (!order) return res.status(404).json({ message: 'Order not found' });
    
    if (req.user.role === 'seller' && order.seller.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    order.deliveryStatus = status;
    order.history.push({ status: status });
    await order.save();
    
    // --- Handle Cancellation Logic ---
    if (status === 'Cancelled') {
        try {
            const assignment = await DeliveryAssignment.findOneAndUpdate(
              { order: order._id },
              { $set: { status: 'Cancelled' }, $push: { history: { status: 'Cancelled' } } },
              { new: true }
            ).populate('deliveryBoy', 'fcmToken');
            
            // Notify Delivery Boy (if assigned)
            if (assignment && assignment.deliveryBoy && assignment.status !== 'Pending') {
                await sendPushNotification(
                    assignment.deliveryBoy.fcmToken,
                    'Order Cancelled',
                    `Order #${order._id.toString().slice(-6)} has been cancelled by the ${req.user.role}.`,
                    { orderId: order._id.toString(), type: 'ORDER_CANCELLED' }
                );
            }

            // Restore Stock (if not failed payment)
            // Restore Stock (if not failed payment)
if (order.paymentStatus !== 'failed' && order.deliveryStatus !== 'Payment Pending') {
    for (const item of order.orderItems) {
        const productDoc = await Product.findById(item.product);
        if (productDoc && productDoc.variants && productDoc.variants.length > 0) {
            // Restore Variant Stock + Main Stock
            await Product.findOneAndUpdate(
                {
                    _id: item.product,
                    "variants": { 
                        $elemMatch: { 
                            color: item.selectedColor || null, 
                            size: item.selectedSize || null 
                        } 
                    }
                },
                { $inc: { "variants.$.stock": item.qty, "stock": item.qty } }
            );
        } else {
            // Restore Main Stock Only
            await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
        }
    }
}

        } catch(assignErr) {
            console.error("Error updating assignment on admin cancel:", assignErr.message);
        }
    }

    const orderIdShort = order._id.toString().slice(-6);
    
    // 1. Send WhatsApp Message
    const userMessage = `Order Update: Your order #${orderIdShort} has been updated to: ${status}.`;
    if (order.user.phone) {
        await sendWhatsApp(order.user.phone, userMessage);
    }

    // 2. ✅ [UPDATED] Save Notification to Database (Bell Icon) & Send Push
    await sendAndSavePersonalNotification(
        order.user._id, // User ID
        'Order Status Updated 📦', // Title
        `Your order #${orderIdShort} is now: ${status}.`, // Body
        { orderId: order._id.toString(), type: 'ORDER_STATUS' } // Data
    );

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
// GET Settings
app.get('/api/admin/settings', protect, authorizeRole('admin'), async (req, res) => {
  try {
    let settings = await AppSettings.findOne({ singleton: true });
    if (!settings) {
      // Create default if not exists
      settings = await AppSettings.create({ 
          singleton: true, 
          platformCommissionRate: 0.05,
          productCreationFee: 10 
      });
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err.message);
    res.status(500).json({ message: 'Error fetching app settings', error: err.message });
  }
});

// PUT Settings (Update Fee & Theme)
// PUT Settings (Update Fee, Theme, & Delivery Radius/Blocks)
// PUT Settings (Update Fee, Theme, & Delivery Radius/Blocks)
// ✅ UPDATED: PUT Settings (Includes Delivery Pricing)
// ==========================================
// ⚙️ UPDATE APP SETTINGS (Admin Panel)
// ==========================================
app.put('/api/admin/settings', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { 
        platformCommissionRate, 
        productCreationFee, 
        theme, 
        
        // Print Settings
        allowPrintCOD, // ✅ NEW: Toggle COD for Print
        bwRatePerPage,
        colorRatePerPage,
        adminPrintCommission,

        // Delivery Settings
        deliveryRadius,      // Global Radius
        deliveryBaseCharge,  // e.g. 30
        deliveryBaseKm,      // e.g. 3
        deliveryPerKmCharge, // e.g. 15
        
        blockedZones,
        blockedPincodes 
    } = req.body;
    
    const updateData = {};

    // --- GENERAL SETTINGS ---
    if (typeof platformCommissionRate !== 'undefined') updateData.platformCommissionRate = parseFloat(platformCommissionRate);
    if (typeof productCreationFee !== 'undefined') updateData.productCreationFee = parseFloat(productCreationFee);
    if (theme) updateData.theme = theme;

    // --- PRINT SETTINGS UPDATE ---
    if (typeof allowPrintCOD !== 'undefined') updateData.allowPrintCOD = (String(allowPrintCOD) === 'true');
    if (typeof bwRatePerPage !== 'undefined') updateData['printConfig.bwRatePerPage'] = parseFloat(bwRatePerPage);
    if (typeof colorRatePerPage !== 'undefined') updateData['printConfig.colorRatePerPage'] = parseFloat(colorRatePerPage);
    if (typeof adminPrintCommission !== 'undefined') updateData['printConfig.adminPrintCommission'] = parseFloat(adminPrintCommission);

    // --- DELIVERY CONFIG UPDATE ---
    
    // 1. Global Radius
    if (typeof deliveryRadius !== 'undefined') updateData['deliveryConfig.globalRadiusKm'] = parseFloat(deliveryRadius);

    // 2. Delivery Pricing
    if (typeof deliveryBaseCharge !== 'undefined') updateData['deliveryConfig.baseCharge'] = parseFloat(deliveryBaseCharge);
    if (typeof deliveryBaseKm !== 'undefined') updateData['deliveryConfig.baseKm'] = parseFloat(deliveryBaseKm);
    if (typeof deliveryPerKmCharge !== 'undefined') updateData['deliveryConfig.extraPerKmCharge'] = parseFloat(deliveryPerKmCharge);

    // 3. Blocked Pincodes
    if (typeof blockedPincodes !== 'undefined') {
        let pins = [];
        if (typeof blockedPincodes === 'string') {
            if (blockedPincodes.trim().length > 0) {
                pins = blockedPincodes.split(',').map(p => p.trim()).filter(p => p !== "");
            }
        } else if (Array.isArray(blockedPincodes)) {
            pins = blockedPincodes;
        }
        updateData['deliveryConfig.blockedPincodes'] = pins;
    }

    // 4. Blocked Zones
    if (typeof blockedZones !== 'undefined') {
        let zones = [];
        if (typeof blockedZones === 'string') {
            try { zones = JSON.parse(blockedZones); } catch (e) { zones = []; }
        } else if (Array.isArray(blockedZones)) {
            zones = blockedZones;
        }
        if (Array.isArray(zones)) {
            updateData['deliveryConfig.blockedZones'] = zones.map(z => ({
                lat: parseFloat(z.lat),
                lng: parseFloat(z.lng),
                radiusKm: parseFloat(z.radiusKm || 1),
                reason: z.reason || 'Restricted Area'
            }));
        }
    }

    const updatedSettings = await AppSettings.findOneAndUpdate(
      { singleton: true },
      { $set: updateData },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(updatedSettings);

  } catch (err) {
    console.error('Error updating settings:', err.message);
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

// ----------------------------------------------------------------------
// ✅ CRON JOB: Delete Inactive Accounts (Older than 6 Months)
// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
// ✅ UPDATED CRON JOB: Archive & Delete Inactive Accounts (6 Months)
// ----------------------------------------------------------------------
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Running Inactive Account Cleanup...');
  
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    // 1. Find Users to Delete (Older than 6 months & Role is 'user')
    const usersToDelete = await User.find({
      role: 'user', 
      lastActiveAt: { $lt: sixMonthsAgo } 
    });

    if (usersToDelete.length > 0) {
      console.log(`Found ${usersToDelete.length} inactive users. Archiving...`);

      // 2. Prepare Archive Data
      const archiveData = usersToDelete.map(user => ({
        originalUserId: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        userData: user.toObject(), // Save full backup
        deletionReason: 'Auto-Inactive',
        deletedAt: new Date()
      }));

      // 3. Clone Data to DeletedUser Collection
      await DeletedUser.insertMany(archiveData);

      // 4. Delete from Main User Collection
      const userIds = usersToDelete.map(u => u._id);
      await User.deleteMany({ _id: { $in: userIds } });

      console.log(`✅ SUCCESS: Archived and Deleted ${usersToDelete.length} users.`);
      
      // Notify Admin
      await notifyAdmin(`🧹 System Cleanup: ${usersToDelete.length} inactive accounts were backed up to 'DeletedUsers' and removed from main list.`);
    } else {
      console.log('✨ No inactive accounts found to delete.');
    }

  } catch (err) {
    console.error('❌ Error during inactive account cleanup:', err.message);
  }
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

// ✅ GET: Notification History (Merged: Personal + Broadcasts)
app.get('/api/notifications/history', protect, async (req, res) => {
    try {
        const userId = req.user._id;
        const userRole = req.user.role || 'user';
        const userCreatedAt = req.user.createdAt; // Taaki purani broadcast na dikhe

        // 1. Fetch Personal Notifications (Last 30)
        const personalNotifsPromise = Notification.find({ user: userId })
            .sort({ sentAt: -1 })
            .limit(30)
            .lean();

        // 2. Fetch Broadcast/Scheduled Notifications (Last 30)
        const broadcastNotifsPromise = ScheduledNotification.find({
            isSent: true,
            target: { $in: ['all', userRole] },
            // Filter: Show broadcasts only created AFTER user registered (Optional logic)
            // sentAt: { $gte: userCreatedAt } 
        })
        .sort({ sentAt: -1 })
        .limit(30)
        .lean();

        // 3. Run queries in parallel
        const [personalNotifs, broadcastNotifs] = await Promise.all([
            personalNotifsPromise,
            broadcastNotifsPromise
        ]);

        // 4. Merge & Sort Combined List
        const allNotifications = [...personalNotifs, ...broadcastNotifs];
        
        // Sort by Date (Newest First)
        allNotifications.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));

        // 5. Format Data for Flutter
        const formattedNotifications = allNotifications.map(n => ({
            id: n._id,
            title: n.title,
            body: n.body,
            imageUrl: n.imageUrl || null, // ScheduledNotification has imageUrl
            sentAt: n.sentAt,
            isRead: n.isRead || false, // Broadcasts usually don't track read status per user
            type: n.target ? 'broadcast' : 'personal' // Frontend icon ke liye
        }));

        res.json(formattedNotifications);

    } catch (err) {
        console.error('Error fetching notification history:', err.message);
        res.status(500).json({ message: 'Error fetching notifications' });
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
// ✅ FULL UPDATED: Buy Now logic with Notifications, Commission, and Stock logic
// ✅ FULL UPDATED: Buy Now logic with detailed Notifications and Commission
app.post('/api/orders/buy-now', protect, async (req, res) => {
    const { productId, variantId, qty = 1, shippingAddressId, paymentMethod, couponCode } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 1. Fetch Product and Shipping Address
        const product = await Product.findById(productId).populate('seller').session(session);
        const shippingAddress = await Address.findById(shippingAddressId).session(session);

        if (!product) throw new Error('Product not found');
        if (!shippingAddress) throw new Error('Shipping address not found');

        // 2. Find specific variant from nested array
        const variant = product.variants.id(variantId);
        if (!variant) throw new Error('Selected variant not found');

        // 3. Stock & Pincode Validations
        if (variant.stock < qty) throw new Error(`Insufficient stock for ${product.name}`);
        if (!product.seller.pincodes.includes(shippingAddress.pincode)) {
            throw new Error(`Delivery not available at your location (${shippingAddress.pincode}).`);
        }

        // 4. Pricing & App Settings
        const itemsTotal = variant.price * qty;
        const appSettings = await AppSettings.findOne({ singleton: true }).session(session);
        const deliveryFee = calculateShippingFee(shippingAddress.pincode);
        const GST_RATE_VAL = (typeof GST_RATE !== 'undefined') ? GST_RATE : 0;
        const taxAmount = itemsTotal * GST_RATE_VAL;
        
        let discountAmount = 0; // Coupon logic yahan merge karein

        const finalAmountForPayment = Math.max(0, itemsTotal + deliveryFee + taxAmount - discountAmount);
        const effectivePaymentMethod = (paymentMethod === 'razorpay' && finalAmountForPayment <= 0) ? 'cod' : paymentMethod;

        // 5. Razorpay Initiation
        let razorpayOrder = null;
        if (effectivePaymentMethod === 'razorpay') {
            razorpayOrder = await razorpay.orders.create({
                amount: Math.round(finalAmountForPayment * 100),
                currency: 'INR',
                receipt: `rcpt_bn_${crypto.randomBytes(4).toString('hex')}`,
            });
        }

        const isCodOrFree = effectivePaymentMethod === 'cod' || finalAmountForPayment === 0;

        // 6. Platform Commission (Wallet Deduction)
        const COMMISSION_RATE = appSettings ? appSettings.platformCommissionRate : 0.05;
        const commissionAmount = parseFloat((itemsTotal * COMMISSION_RATE).toFixed(2));
        const sellerUser = await User.findById(product.seller._id).session(session);
        
        const balanceBefore = sellerUser.walletBalance;
        sellerUser.walletBalance -= commissionAmount;
        await sellerUser.save({ session });

        // 7. Save Order Document
        const order = new Order({
            user: req.user._id,
            seller: product.seller._id,
            orderItems: [{
                product: product._id,
                name: product.name,
                qty: qty,
                price: variant.price,
                originalPrice: variant.originalPrice || product.originalPrice,
                selectedColor: variant.color,
                selectedSize: variant.size,
                unit: product.unit || 'pcs', // Important for notification
                isPrintJob: false
            }],
            shippingAddress: `${shippingAddress.street}, ${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}`,
            pincode: shippingAddress.pincode,
            paymentMethod: effectivePaymentMethod,
            totalAmount: itemsTotal,
            taxAmount,
            discountAmount,
            shippingFee: deliveryFee,
            paymentId: razorpayOrder ? razorpayOrder.id : (isCodOrFree ? `cod_${crypto.randomBytes(8).toString('hex')}` : undefined),
            paymentStatus: isCodOrFree ? 'completed' : 'pending',
            deliveryStatus: isCodOrFree ? 'Pending' : 'Payment Pending',
            history: [{ status: isCodOrFree ? 'Pending' : 'Payment Pending' }]
        });
        await order.save({ session });

        // 8. Log Commission Transaction
        await WalletTransaction.create([{
            seller: product.seller._id,
            orderId: order._id,
            type: 'Debit',
            amount: commissionAmount,
            balanceBefore,
            balanceAfter: sellerUser.walletBalance,
            description: `Commission for Buy Now #${order._id.toString().slice(-6)}`
        }], { session });

        // 9. Post-Order Logic (Stock, WhatsApp, FCM)
        if (isCodOrFree) {
            // Decrement Stock
            variant.stock -= qty;
            await product.save({ session });

            const orderIdShort = order._id.toString().slice(-6);
            
            // --- DETAILED NOTIFICATION MESSAGE ---
            const itemString = `${product.name} | ₹${variant.price}/${product.unit || 'pcs'} (Qty: ${qty})`;
            const sellerPushMsg = `New Buy Now Order #${orderIdShort} for ₹${order.totalAmount.toFixed(2)}`;
            // ✅ UPDATED: Detailed Notifications for Buy Now
            const sellerWhatsAppMsg = `🎉 *New Buy Now Order!* (#${orderIdShort})\n\n` +
                          `👤 *Customer:* ${req.user.name}\n` +
                          `📞 *Contact:* ${req.user.phone}\n\n` +
                          `📦 *Item:* ${product.name} | ₹${variant.price} (Qty: ${qty})\n` +
                          `💰 *Collect:* ₹${order.totalAmount.toFixed(2)}`;

             await sendWhatsApp(sellerUser.phone, sellerWhatsAppMsg);

            // Push Notification to Seller
            if (sellerUser.fcmToken) {
                await sendPushNotification(
                    [sellerUser.fcmToken],
                    'New Order Received! 🛍️',
                    sellerPushMsg,
                    { orderId: order._id.toString(), type: 'NEW_ORDER' }
                );
            }

            // Create Delivery Assignment & Notify Delivery Boys
            await DeliveryAssignment.create([{
                order: order._id, status: 'Pending', pincode: shippingAddress.pincode
            }], { session });

            const deliveryBoys = await User.find({ role: 'delivery', approved: true, pincodes: shippingAddress.pincode }).select('fcmToken');
            const deliveryTokens = deliveryBoys.map(db => db.fcmToken).filter(Boolean);
            if (deliveryTokens.length > 0) {
              await sendPushNotification(deliveryTokens, 'New Delivery Available! 🛵', `New order in ${shippingAddress.pincode}.`, { orderId: order._id.toString(), type: 'NEW_DELIVERY_AVAILABLE' });
            }
        }

        await session.commitTransaction();
        session.endSession();

        res.status(201).json({
            message: effectivePaymentMethod === 'razorpay' ? 'Order initiated.' : 'Order placed successfully.',
            orders: [order._id],
            razorpayOrder: razorpayOrder ? { id: razorpayOrder.id, amount: razorpayOrder.amount, key_id: process.env.RAZORPAY_KEY_ID } : undefined,
            grandTotal: finalAmountForPayment
        });

    } catch (err) {
        if (session.inTransaction()) await session.abortTransaction();
        session.endSession();
        res.status(500).json({ message: err.message });
    }
});

// [NEW] API Endpoint for a customer to initiate a return request
app.post('/api/orders/:id/return-request', protect, async (req, res) => {
    try {
        // ✅ FIX: Destructure both reason and the optional upiId from the body
        const { reason, upiId } = req.body; 
        
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

        // Calculate time remaining for the response message
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
            // ✅ FIX: Save UPI ID here if provided by the user
            upiId: upiId || null, 
            createdAt: new Date(),
            updatedAt: new Date()
        });
        
        // Update the order status to reflect the request
        order.deliveryStatus = 'Return Requested'; 
        order.history.push({ status: 'Return Requested', note: `Reason: ${reason}` });

        await order.save();
        
        // 4. Notify Admin (Include UPI ID in notification)
        await notifyAdmin(
            `🔔 New Return Request for Order #${order._id.toString().slice(-6)}\n\n` +
            `User: ${req.user.name}\n` +
            `Reason: ${reason}\n` +
            `UPI ID: ${upiId || 'Not Provided'}`
        );

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
// [CORRECTED ADMIN ROUTE] - Admin approves customer return request and creates/updates delivery assignment
// [CORRECTED ADMIN ROUTE] - Admin approves customer return request and updates existing assignment
// [CORRECTED ADMIN ROUTE] - Admin approves customer return request and updates existing assignment


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
// ✅ NEW: Allow users to delete their own account manually
// ✅ MANUAL DELETE ACCOUNT (With Cloning)
app.delete('/api/auth/delete-account', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Check for pending orders
    const pendingOrders = await Order.countDocuments({ 
        user: userId, 
        deliveryStatus: { $in: ['Pending', 'Processing', 'Shipped'] } 
    });

    if (pendingOrders > 0) {
        return res.status(400).json({ message: 'Cannot delete account. You have pending orders.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    // 1. Clone/Archive User
    await DeletedUser.create({
        originalUserId: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        userData: user.toObject(),
        deletionReason: 'Manual-Request',
        deletedAt: new Date()
    });

    // 2. Delete User
    await User.findByIdAndDelete(userId);

    res.json({ message: 'Your account has been securely archived and deleted.' });

  } catch (err) {
    console.error('Manual delete error:', err);
    res.status(500).json({ message: 'Error deleting account', error: err.message });
  }
});
// ------------------------------------------------------------------
// ✅ NEW MODEL: To Store Deleted/Archived Users
// ------------------------------------------------------------------
const deletedUserSchema = new mongoose.Schema({
  originalUserId: { type: mongoose.Schema.Types.ObjectId, index: true },
  name: String,
  email: String,
  phone: String,
  role: String,
  userData: { type: Object }, // Store full original JSON data here
  deletionReason: { type: String, enum: ['Auto-Inactive', 'Manual-Request'], required: true },
  deletedAt: { type: Date, default: Date.now }
}, { strict: false }); // strict: false allows saving any extra fields

const DeletedUser = mongoose.model('DeletedUser', deletedUserSchema);
// --------- Affiliate Product Model (New) ----------
const affiliateProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true }, // Display price
  originalPrice: Number, // MRP (Optional)
  
  // External Link (Amazon/Flipkart/etc.)
  affiliateLink: { type: String, required: true }, 
  
  // Platform Name (e.g., 'Amazon', 'Flipkart', 'Myntra')
  platform: { type: String, required: true, default: 'Amazon' },
  
  image: {
    url: String,
    publicId: String
  },
  
  // Optional: Link to existing category structure
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' }, 
  
  isActive: { type: Boolean, default: true },
  clicks: { type: Number, default: 0 }, // Analytics: Track how many people clicked
}, { timestamps: true });

const AffiliateProduct = mongoose.model('AffiliateProduct', affiliateProductSchema);
// --------------------------------------------------------------------------------
// --------- ADMIN AFFILIATE ROUTES (Manage External Products) ----------
// --------------------------------------------------------------------------------

// 1. Create a new Affiliate Product
app.post('/api/admin/affiliate-products', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
  try {
    const { name, description, price, originalPrice, affiliateLink, platform, category, isActive } = req.body;
    
    if (!name || !price || !affiliateLink || !req.file) {
      return res.status(400).json({ message: 'Name, Price, Affiliate Link and Image are required.' });
    }

    const newProduct = await AffiliateProduct.create({
      name,
      description,
      price: parseFloat(price),
      originalPrice: originalPrice ? parseFloat(originalPrice) : undefined,
      affiliateLink,
      platform: platform || 'Amazon',
      category: category || null,
      isActive: isActive === 'true',
      image: {
        url: req.file.path,
        publicId: req.file.filename
      }
    });

    res.status(201).json({ message: 'Affiliate product created successfully', product: newProduct });

  } catch (err) {
    console.error('Create affiliate product error:', err.message);
    res.status(500).json({ message: 'Error creating affiliate product', error: err.message });
  }
});

// 2. Update an Affiliate Product
app.put('/api/admin/affiliate-products/:id', protect, authorizeRole('admin'), uploadSingleMedia, async (req, res) => {
  try {
    const { name, description, price, originalPrice, affiliateLink, platform, category, isActive } = req.body;
    
    const product = await AffiliateProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Handle Image Update
    if (req.file) {
      if (product.image && product.image.publicId) {
        await cloudinary.uploader.destroy(product.image.publicId);
      }
      product.image = { url: req.file.path, publicId: req.file.filename };
    }

    if (name) product.name = name;
    if (description) product.description = description;
    if (price) product.price = parseFloat(price);
    if (originalPrice) product.originalPrice = parseFloat(originalPrice);
    if (affiliateLink) product.affiliateLink = affiliateLink;
    if (platform) product.platform = platform;
    if (category) product.category = category;
    if (typeof isActive !== 'undefined') product.isActive = isActive === 'true';

    await product.save();
    res.json({ message: 'Affiliate product updated', product });

  } catch (err) {
    res.status(500).json({ message: 'Error updating affiliate product', error: err.message });
  }
});

// 3. Delete an Affiliate Product
app.delete('/api/admin/affiliate-products/:id', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const product = await AffiliateProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    if (product.image && product.image.publicId) {
      await cloudinary.uploader.destroy(product.image.publicId);
    }

    await product.deleteOne();
    res.json({ message: 'Affiliate product deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting product', error: err.message });
  }
});
// --------------------------------------------------------------------------------
// --------- PUBLIC AFFILIATE ROUTES (For Users) ----------
// --------------------------------------------------------------------------------

// 1. Get All Affiliate Products (With Filtering)
app.get('/api/affiliate-products', async (req, res) => {
  try {
    const { category, platform, search } = req.query;
    const query = { isActive: true };

    if (category) query.category = category;
    if (platform) query.platform = platform;
    if (search) {
        query.name = { $regex: search, $options: 'i' };
    }

    const products = await AffiliateProduct.find(query)
      .populate('category', 'name')
      .sort({ createdAt: -1 });

    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching affiliate products', error: err.message });
  }
});

// 2. Track Clicks (Analytics) - Call this when user clicks "Buy on Amazon"
app.put('/api/affiliate-products/:id/click', async (req, res) => {
  try {
    await AffiliateProduct.findByIdAndUpdate(req.params.id, { $inc: { clicks: 1 } });
    res.json({ message: 'Click tracked' });
  } catch (err) {
    console.error('Error tracking click:', err.message);
    // Don't block the UI if tracking fails
    res.status(200).json({ message: 'Tracking ignored due to error' }); 
  }
});

// --------------------------------------------------------------------------------
// --------- VILLAGE SERVICE BOOKING ROUTES ----------
// --------------------------------------------------------------------------------

// 1. सर्विस बुक करें (Book a Service)
// --------------------------------------------------------------------------------
// --------- VILLAGE SERVICE BOOKING ROUTES ----------
// --------------------------------------------------------------------------------

// 1. Book a Service (Direct Booking - No Cart)
// ------------------------------------------------------------------
// ✅ BOOKING ROUTES (Updated for Service Model)
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// ✅ BOOKING ROUTES (Updated for Service Model)
// ------------------------------------------------------------------

app.post('/api/services/book', protect, async (req, res) => {
  try {
    const { serviceId, date, time, addressId, notes } = req.body;

    // 1. Fetch from SERVICE model, not Product
    const serviceItem = await Service.findById(serviceId).populate('provider'); 
    
    if (!serviceItem) {
      return res.status(404).json({ message: 'Invalid service selected.' });
    }
    
    // Check Address
    const userAddress = await Address.findById(addressId);
    if (!userAddress) return res.status(404).json({ message: 'Address not found.' });

    // 2. Create Booking
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // Start OTP

    const booking = await ServiceBooking.create({
      user: req.user._id,
      service: serviceId, // Links to Service Model
      provider: serviceItem.provider._id, // Links to Provider User
      bookingDate: new Date(date),
      timeSlot: time,
      address: {
        street: userAddress.street,
        village: userAddress.village,
        city: userAddress.city,
        phone: userAddress.phone || req.user.phone
      },
      amount: serviceItem.price + (serviceItem.visitCharge || 0), // Total Price
      startOtp: otp,
      notes: notes,
      status: 'Pending'
    });

    // Notify Provider (WhatsApp)
    if (serviceItem.provider && serviceItem.provider.phone) {
        const msg = `🔔 New Booking!\nService: ${serviceItem.name}\nCustomer: ${req.user.name}\nVillage: ${userAddress.village}\nTime: ${time}`;
        await sendWhatsApp(serviceItem.provider.phone, msg);
    }

    res.status(201).json({ message: 'Booking confirmed!', bookingId: booking._id });

  } catch (err) {
    console.error('Booking error:', err.message);
    res.status(500).json({ message: 'Error booking service' });
  }
});

// 2. Get Customer's Bookings
app.get('/api/services/bookings', protect, async (req, res) => {
  try {
    const bookings = await ServiceBooking.find({ user: req.user._id })
      .populate('service', 'name images price')
      .populate('provider', 'name phone')
      .sort({ createdAt: -1 });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching bookings' });
  }
});

// 3. Get Provider's Assigned Jobs (For "Provider" Role)
// ------------------------------------------------------------------
// ✅ PROVIDER SPECIFIC ENDPOINTS (Updated)
// ------------------------------------------------------------------

// 1. Get Provider's Assigned Jobs (For "Provider" Role)
// This populates the "Service Bookings" tab in your HTML panel
app.get('/api/provider/jobs', protect, async (req, res) => {
  try {
    // Allow sellers (who listed the service) or dedicated providers to see jobs
    if (!['seller', 'provider', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Access denied. Only providers can view jobs.' });
    }

    // Find bookings where the logged-in user is the 'provider'
    const jobs = await ServiceBooking.find({ provider: req.user._id })
      .populate('service', 'name price images') // Get Service Name & Price
      .populate('user', 'name phone')           // Get Customer Details
      .sort({ bookingDate: 1 });                // Sort by upcoming date
      
    res.json(jobs);
  } catch (err) {
    console.error("Error fetching provider jobs:", err.message);
    res.status(500).json({ message: 'Error fetching jobs', error: err.message });
  }
});

// 2. Update Booking Status (Accept, Start with OTP, Complete)
// This handles the buttons: "Accept", "I'm On The Way", "Start Service (OTP)", "Complete"
// 2. Update Booking Status (Accept, Start with OTP, Complete)
// 2. Update Booking Status (Accept, Start, Complete) - OTP Removed
app.put('/api/services/bookings/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body; // OTP ab body se nahi chahiye
    const bookingId = req.params.id;

    const booking = await ServiceBooking.findById(bookingId)
      .populate('user', 'phone fcmToken name')
      .populate('service', 'name');

    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    // --- FIX 1: Safe Authorization Check ---
    const providerId = booking.provider ? booking.provider.toString() : null;
    
    if (providerId !== req.user._id.toString() && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Not authorized to update this booking' });
    }

    // --- OTP LOGIC REMOVED ---
    // Maine yahan se OTP check karne wala 'if' block hata diya hai.
    // Ab direct status update hoga.

    // Update Status
    booking.status = status;
    booking.history.push({ status: status, timestamp: new Date() });

    // If COD and Service Completed -> Mark Payment as Completed
    if (status === 'Completed' && booking.paymentMethod === 'cod') {
        booking.paymentStatus = 'completed';
    }

    await booking.save();

    // --- FIX 2: Safe Notifications ---
    const customerName = booking.user ? booking.user.name : 'Customer';
    const serviceName = booking.service ? booking.service.name : 'Service';
    
    // Construct Message
    let msg = '';
    if (status === 'Accepted') {
        msg = `✅ Booking Confirmed! Dear ${customerName}, your request for ${serviceName} has been accepted by ${req.user.name}.`;
    } else if (status === 'OnTheWay') {
        msg = `🚗 Technician En Route! ${req.user.name} is on the way to your location for ${serviceName}.`;
    } else if (status === 'InProgress') {
        msg = `🛠️ Service Started! The work for ${serviceName} has begun.`;
    } else if (status === 'Completed') {
        msg = `🎉 Service Completed! Your ${serviceName} is done. Please pay ₹${booking.amount}. Thank you!`;
    } else if (status === 'Rejected') {
        msg = `❌ Booking Update: Your request for ${serviceName} could not be accepted at this time.`;
    }

    // Send Notifications (Safe)
    if (booking.user && msg) {
      if (booking.user.phone) {
          try { await sendWhatsApp(booking.user.phone, msg); } catch (e) {}
      }
      
      if (booking.user.fcmToken) {
         try {
             await sendPushNotification(
                 booking.user.fcmToken, 
                 'Service Update 🛠️', 
                 msg, 
                 { type: 'SERVICE_UPDATE', bookingId: booking._id.toString() }
             );
         } catch (e) {}
      }
    }

    res.json({ message: `Booking status updated to ${status}`, booking });

  } catch (err) {
    console.error('Error updating service status:', err.message);
    res.status(500).json({ message: 'Error updating status', error: err.message });
  }
});
// ------------------------------------------------------------------
// ✅ SERVICE API ROUTES (Separate from Products)
// ------------------------------------------------------------------

// 1. Get All Services (With Village Filter)
app.get('/api/services', async (req, res) => {
  try {
    const { village, categoryId, search } = req.query;
    const filter = { isAvailable: true };

    if (village) {
      // Check if service is available in this village (or all)
      filter.$or = [
          { villages: { $in: [village] } },
          { villages: { $size: 0 } } // If empty, assume available everywhere
      ];
    }
    if (categoryId) filter.category = categoryId;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const services = await Service.find(filter)
      .populate('provider', 'name phone profileImage rating') // Provider details
      .populate('category', 'name');
      
    res.json(services);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching services' });
  }
});

// 2. Get Single Service Details
app.get('/api/services/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id)
      .populate('provider', 'name phone experience')
      .populate('category', 'name');
    if(!service) return res.status(404).json({ message: 'Service not found' });
    res.json(service);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching service details' });
  }
});

// 3. Add New Service (Provider Only)
app.post('/api/services', protect, authorizeRole('provider', 'seller', 'admin'), upload.array('images', 5), async (req, res) => {
  try {
    const { name, category, price, visitCharge, description, experience, villages } = req.body;
    
    // Image Upload Process
    const imageFiles = req.files.map(file => ({
      url: file.path,
      publicId: file.filename
    }));

    // Parse villages JSON if sent as string
    let villageList = [];
    if(villages) {
        try { villageList = JSON.parse(villages); } catch(e) { villageList = [villages]; }
    }

    const newService = await Service.create({
      name,
      category,
      provider: req.user._id, // Logged in user is the provider
      price: parseFloat(price),
      visitCharge: parseFloat(visitCharge || 0),
      description,
      experience,
      images: imageFiles,
      villages: villageList
    });

    res.status(201).json({ message: 'Service listed successfully', service: newService });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error creating service', error: err.message });
  }
});

// 4. Delete Service (Provider/Admin)
app.delete('/api/services/:id', protect, authorizeRole('provider', 'admin'), async (req, res) => {
    try {
        const service = await Service.findById(req.params.id);
        if(!service) return res.status(404).json({ message: 'Service not found' });
        
        // Ensure provider owns the service
        if(req.user.role !== 'admin' && service.provider.toString() !== req.user._id.toString()){
             return res.status(403).json({ message: 'Unauthorized' });
        }
        
        await service.deleteOne();
        res.json({ message: 'Service deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Error deleting service' });
    }
});

// --------------------------------------------------------------------------------
// --------- 🚖 RIDE BOOKING & WALLET ROUTES (NEW) 🚖 ----------
// --------------------------------------------------------------------------------

// Constants
const MIN_DRIVER_BALANCE = 00;
const COMMISSION_PERCENTAGE = 10; // 10% Platform fee

// 1. Update Driver Location & Status (Online/Offline)
// 1. Update Driver Location & Status (Online/Offline)
// 1. Update Driver Location & Status (With Auto-Unblock Logic)
app.put('/api/ride/driver/status', protect, async (req, res) => {
    try {
        const { isOnline, latitude, longitude } = req.body;
        const user = req.user;

        // सिर्फ ड्राइवर ही अपना स्टेटस अपडेट कर सकता है
        if (user.role !== 'driver') {
            return res.status(403).json({ message: 'Only drivers can update status' });
        }

        // ✅ 1. AUTO-UNLOCK LOGIC (Smart Check)
        // अगर ड्राइवर लॉक्ड है और उसका बैन टाइम खत्म हो चुका है, तो उसे अनब्लॉक करें
        if (user.isLocked && user.lockExpiresAt && new Date() > user.lockExpiresAt) {
            user.isLocked = false;
            user.lockExpiresAt = null;
            user.blockReason = null;
            console.log(`🔓 Driver ${user.name} auto-unlocked after ban expiry.`);
        }

        // ✅ 2. BLOCK CHECK (Prevent Online if still locked)
        // यह 'Low Balance' या 'Permanent Ban' दोनों को हैंडल करेगा
        if (isOnline && user.isLocked) {
            // अगर कोई खास वजह (blockReason) है तो वह दिखाओ, वरना "Low Balance" दिखाओ
            const msg = user.blockReason || 'Wallet balance low (Min ₹30). Please recharge.';
            return res.status(400).json({ message: `Access Denied: ${msg}` });
        }

        // 3. ऑनलाइन/ऑफलाइन स्टेटस अपडेट करें
        user.isOnline = isOnline;

        // 4. अगर लोकेशन भेजी गई है, तो उसे अपडेट करें
        if (latitude !== undefined && longitude !== undefined) {
            user.location = { 
                type: 'Point', 
                coordinates: [parseFloat(longitude), parseFloat(latitude)] 
            };
        }

        await user.save();

        res.json({ 
            message: 'Driver status updated', 
            isOnline: user.isOnline, 
            isLocked: user.isLocked,
            walletBalance: user.walletBalance
        });

    } catch (err) {
        console.error('Driver status update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c; // Distance in km
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

// 2. Request a Ride (Sequential Dispatch Logic)
// 2. Request a Ride (Sequential Dispatch Logic)
// 2. Request a Ride (Sequential Dispatch Logic)
app.post('/api/ride/request', protect, async (req, res) => {
    try {
        const { pickupAddress, pickupCoordinates, dropAddress, dropCoordinates, vehicleType } = req.body;

        // Calculate Distance & Fare
        const lat1 = pickupCoordinates[1]; const lon1 = pickupCoordinates[0];
        const lat2 = dropCoordinates[1]; const lon2 = dropCoordinates[0];
        
        // Ensure you have the helper function 'getDistanceFromLatLonInKm' defined in server.js
        let rawDistance = getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2);
        const distanceKm = parseFloat((rawDistance * 1.3).toFixed(1));
        
        const rates = { 'Bike': 10, 'Auto': 15, 'Car': 25, 'E-Rickshaw': 12 };
        let estimatedFare = Math.round(20 + (distanceKm * (rates[vehicleType] || 15)));

        // ✅ 1. Find ALL Nearby Drivers
        const nearbyDrivers = await User.find({
            role: 'driver',
            vehicleType: vehicleType,
            isOnline: true,
            isLocked: false,
            location: {
                $near: {
                    $geometry: { type: "Point", coordinates: pickupCoordinates },
                    $maxDistance: 5000 // 5km Radius
                }
            }
        });

        if (nearbyDrivers.length === 0) return res.status(404).json({ message: 'No drivers nearby' });

        // ✅ 2. Create Ride with Driver List (Queue)
        const newRide = await Ride.create({
            customer: req.user._id,
            vehicleType,
            pickupLocation: { address: pickupAddress, coordinates: pickupCoordinates },
            dropLocation: { address: dropAddress, coordinates: dropCoordinates },
            distanceKm,
            estimatedFare,
            otp: Math.floor(1000 + Math.random() * 9000).toString(),
            status: 'Requested',
            
            // Store List & Index
            potentialDrivers: nearbyDrivers.map(d => d._id), 
            currentDriverIndex: 0, 
            rejectedDrivers: []
        });

        // ✅ 3. Notify ONLY the FIRST Driver
        const firstDriver = nearbyDrivers[0];
        if (firstDriver.fcmToken) {
            // Updated payload to include 'type' so Flutter app knows to open the Ride Popup
            await sendPushNotification(
                [firstDriver.fcmToken], 
                'New Ride Request 🚖', 
                `A Rider is within your range! 📍 Earn ₹${estimatedFare}`, 
                { rideId: newRide._id.toString(), type: 'NEW_RIDE' }
            );
        }

        // ✅ 4. START BACKEND TIMER (Crucial Step)
        // This starts the 30s countdown for the first driver (index 0)
        if (typeof scheduleRideTimeout === 'function') {
            scheduleRideTimeout(newRide._id, 0);
        } else {
            console.error("❌ Error: scheduleRideTimeout function is missing in server.js");
        }

        res.status(201).json({ message: 'Ride requested', rideId: newRide._id });

    } catch (err) {
        console.error("Ride Request Error:", err);
        res.status(500).json({ error: err.message });
    }
});
// 3. Accept Ride (Driver)
app.post('/api/ride/accept', protect, async (req, res) => {
    try {
        const { rideId } = req.body;
        const driver = req.user;

        // Security Check
        if (driver.isLocked || driver.walletBalance < MIN_DRIVER_BALANCE) {
            return res.status(403).json({ message: 'Wallet Low. Please recharge (Min ₹50) to accept rides.' });
        }

        const ride = await Ride.findById(rideId);
        if (!ride || ride.status !== 'Requested') {
            return res.status(400).json({ message: 'Ride already accepted or cancelled.' });
        }

        ride.driver = driver._id;
        ride.status = 'Accepted';
        await ride.save();

        // Notify Customer
        const customer = await User.findById(ride.customer).select('fcmToken phone');
        if (customer && customer.fcmToken) {
            await sendPushNotification(
                customer.fcmToken,
                'Ride Accepted ✅',
                `${driver.name} is on the way! OTP: ${ride.otp}`,
                { rideId: ride._id.toString(), type: 'RIDE_ACCEPTED' }
            );
        }

        res.json({ message: 'Ride Accepted', ride });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Start Ride (Verify OTP)
app.post('/api/ride/start', protect, async (req, res) => {
    try {
        const { rideId, otp } = req.body;
        const ride = await Ride.findById(rideId);

        if (ride.driver.toString() !== req.user._id.toString()) return res.status(403).json({message: 'Unauthorized'});
        if (ride.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });

        ride.status = 'InProgress';
        await ride.save();

        res.json({ message: 'Ride Started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Complete Ride & Deduct Commission (CORE LOGIC)
app.post('/api/ride/complete', protect, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { rideId } = req.body;
        const ride = await Ride.findById(rideId).session(session);

        if (!ride || ride.status !== 'InProgress') {
            await session.abortTransaction();
            return res.status(400).json({ message: 'Invalid Ride Status' });
        }

        // Calculate Stats
        const finalFare = ride.estimatedFare; // In real app, re-calculate based on actual time/dist
        const commission = Math.round((finalFare * COMMISSION_PERCENTAGE) / 100);
        
        ride.status = 'Completed';
        ride.finalFare = finalFare;
        ride.commissionAmount = commission;
        ride.paymentStatus = 'Completed'; // Assuming Cash collected
        await ride.save({ session });

        // --- WALLET DEDUCTION ---
        const driver = await User.findById(req.user._id).session(session);
        const balanceBefore = driver.walletBalance;
        
        driver.walletBalance -= commission; // Deduct commission
        
        // CHECK LOCK CONDITION
        let lockMessage = '';
        if (driver.walletBalance < MIN_DRIVER_BALANCE) {
            driver.isLocked = true;
            driver.isOnline = false; // Force offline
            lockMessage = ' ALERT: Wallet low. You are now locked from receiving new rides.';
        }

        await driver.save({ session });

        // Log Transaction
        await WalletTransaction.create([{
            driver: driver._id,
            rideId: ride._id,
            type: 'Debit',
            amount: commission,
            balanceBefore: balanceBefore,
            balanceAfter: driver.walletBalance,
            description: `Commission for Ride #${ride._id.toString().slice(-4)}`
        }], { session });

        await session.commitTransaction();

        res.json({ 
            message: `Ride Completed. Commission ₹${commission} deducted.${lockMessage}`, 
            walletBalance: driver.walletBalance, 
            isLocked: driver.isLocked 
        });

    } catch (err) {
        await session.abortTransaction();
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        session.endSession();
    }
});

// 6. Add Money to Wallet (Simulated for Demo)
app.post('/api/wallet/add', protect, async (req, res) => {
    try {
        const { amount } = req.body; // In real app, verify Razorpay/Payment ID here
        const user = req.user;

        if (user.role !== 'driver') return res.status(403).json({ message: 'Only drivers have wallets' });

        const balanceBefore = user.walletBalance;
        user.walletBalance += parseFloat(amount);

        // UNLOCK if balance is sufficient
        if (user.walletBalance >= MIN_DRIVER_BALANCE) {
            user.isLocked = false;
        }

        await user.save();

        await WalletTransaction.create({
            driver: user._id,
            type: 'Credit',
            amount: amount,
            balanceBefore,
            balanceAfter: user.walletBalance,
            description: 'Wallet Recharge'
        });

        res.json({ message: 'Wallet recharged successfully', newBalance: user.walletBalance, isLocked: user.isLocked });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 7. Get Wallet History
// 7. Get Wallet History (Updated for both Sellers & Drivers)
app.get('/api/wallet/history', protect, async (req, res) => {
    try {
        const userId = req.user._id;
        let query = {};

        // ✅ Check Role to determine which field to query in WalletTransaction
        if (req.user.role === 'seller') {
            query = { seller: userId };
        } else {
            // Default to driver (or you can check if req.user.role === 'driver')
            query = { driver: userId };
        }

        const history = await WalletTransaction.find(query).sort({ createdAt: -1 });

        res.json({ 
            balance: req.user.walletBalance, 
            isLocked: req.user.isLocked, // Mostly relevant for drivers
            history: history 
        });
    } catch (err) {
        console.error("Wallet History Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// [UPDATED] Driver Polling Route (Sequential Dispatch - Nearest First)
app.get('/api/ride/pending', protect, async (req, res) => {
    try {
        const driverId = req.user._id.toString();

        // 1. Find rides where status is Requested & matches vehicle type
        const rides = await Ride.find({
            status: 'Requested',
            vehicleType: req.user.vehicleType
        }).sort({ createdAt: -1 });

        // ✅ 2. FILTER: Show ride ONLY if it's THIS driver's turn
        // (Check potentialDrivers array at currentDriverIndex)
        const myRide = rides.find(ride => {
            if (!ride.potentialDrivers || ride.potentialDrivers.length === 0) return false;
            
            const currentDriverId = ride.potentialDrivers[ride.currentDriverIndex];
            return currentDriverId && currentDriverId.toString() === driverId;
        });

        if (!myRide) {
            return res.json([]); // If no ride is assigned to this driver currently
        }

        console.log(`🚖 Driver ${req.user.name} is seeing ride: ${myRide._id}`);

        // 3. Format Data for Flutter
        const formattedRides = [{
            rideId: myRide._id,
            pickup: myRide.pickupLocation.address || "Unknown Pickup",
            drop: myRide.dropLocation.address || "Unknown Drop",
            fare: myRide.estimatedFare,
            otp: myRide.otp,
            pickupLatLng: {
                lat: myRide.pickupLocation.coordinates[1],
                lng: myRide.pickupLocation.coordinates[0]
            },
            dropLatLng: {
                lat: myRide.dropLocation.coordinates[1],
                lng: myRide.dropLocation.coordinates[0]
            }
        }];

        res.json(formattedRides);

    } catch (err) {
        console.error('❌ Polling Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// 3. Decline Ride (Pass to Next Driver)
app.post('/api/ride/decline', protect, async (req, res) => {
    try {
        const { rideId } = req.body;
        const driverId = req.user._id;

        const ride = await Ride.findById(rideId);
        if (!ride) return res.status(404).json({ message: 'Ride not found' });

        // 1. Add to rejected list (ताकि हमें पता रहे किसने मना किया)
        if (!ride.rejectedDrivers.includes(driverId)) {
            ride.rejectedDrivers.push(driverId);
        }

        // ✅ 2. Move to Next Driver
        ride.currentDriverIndex += 1;

        // 🔄 3. LOOP LOGIC: अगर लिस्ट खत्म हो गई, तो वापस पहले ड्राइवर (0) पर जाएं
        if (ride.currentDriverIndex >= ride.potentialDrivers.length) {
            console.log(`♻️ All drivers declined. Looping back to first driver for Ride #${ride._id}`);
            ride.currentDriverIndex = 0; // Reset Index
            ride.rejectedDrivers = [];   // Clear rejection history for new round
        }

        await ride.save();

        // ✅ 4. Notify the Driver at current index (WITH ONLINE CHECK)
        const nextDriverId = ride.potentialDrivers[ride.currentDriverIndex];
        
        // 🔥 UPDATE: Added 'isOnline' to the select query
        const nextDriver = await User.findById(nextDriverId).select('fcmToken name isOnline');

        // 🔥 UPDATE: Added '&& nextDriver.isOnline' check
        if (nextDriver && nextDriver.isOnline && nextDriver.fcmToken) {
            console.log(`🔀 Shifting ride to: ${nextDriver.name}`);
            await sendPushNotification(
                [nextDriver.fcmToken],
                'New Ride Request 🚖',
                `Ride Available! Earn ₹${ride.estimatedFare}`,
                { rideId: ride._id.toString(), type: 'NEW_RIDE' }
            );
        } else {
             // Log if skipped due to offline status
             console.log(`⚠️ Next driver ${nextDriver ? nextDriver.name : 'Unknown'} is OFFLINE. Notification skipped.`);
        }

        res.json({ message: 'Ride passed to next driver (Loop active)' });

    } catch (err) {
        console.error('Decline Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/ride/nearby-count', async (req, res) => {
    try {
        const { lat, lng } = req.query;
        if (!lat || !lng) return res.json({ count: 0 });

        const drivers = await User.find({
            role: 'driver',
            isOnline: true,
            isLocked: false,
            location: {
                $near: {
                    $geometry: { type: "Point", coordinates: [parseFloat(lng), parseFloat(lat)] },
                    $maxDistance: 5000 // 5km Radius
                }
            }
        });
        res.json({ count: drivers.length });
    } catch (err) {
        console.error(err);
        res.json({ count: 0 });
    }
});

// --------------------------------------------------------------------
// 💰 WALLET RECHARGE WITH RAZORPAY (Real Payment)
// --------------------------------------------------------------------

// 1. Create Razorpay Order for Wallet Recharge
// --------------------------------------------------------------------
// 💰 WALLET RECHARGE WITH RAZORPAY (Real Payment)
// --------------------------------------------------------------------

// 1. Create Razorpay Order
app.post('/api/wallet/create-order', protect, async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount || amount < 1) return res.status(400).json({ message: 'Invalid amount' });

        const options = {
            amount: Math.round(amount * 100), // Amount in paise
            currency: "INR",
            receipt: `wlt_${crypto.randomBytes(4).toString('hex')}`,
            notes: { userId: req.user._id.toString(), type: 'wallet_recharge' }
        };

        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (err) {
        console.error("Razorpay Order Error:", err);
        res.status(500).json({ message: 'Error creating payment order' });
    }
});

// 2. Verify Payment & Credit Wallet
app.post('/api/wallet/verify-recharge', protect, async (req, res) => {
    try {
        // नोट: हम body से 'amount' नहीं ले रहे हैं (सुरक्षा के लिए)
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const user = req.user;

        if (user.role !== 'driver' && user.role !== 'seller') {
            return res.status(403).json({ message: 'Wallet feature is only for drivers and sellers' });
        }

        // 🛡️ 1. Signature Verification (Same as before)
        const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
        shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
        const digest = shasum.digest('hex');

        if (digest !== razorpay_signature) {
            return res.status(400).json({ message: 'Transaction verification failed' });
        }

        // 🛡️ 2. CRITICAL SECURITY: Fetch Actual Amount from Razorpay API
        // यह सुनिश्चित करता है कि यूजर ने अमाउंट के साथ छेड़छाड़ नहीं की है
        const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);

        if (paymentDetails.status !== 'captured') {
            return res.status(400).json({ message: 'Payment not captured or failed' });
        }

        // Razorpay अमाउंट को 'paise' में देता है, इसे 'rupees' में बदलें
        const verifiedAmount = paymentDetails.amount / 100; 

        // 🛡️ 3. Idempotency Check: क्या यह Payment ID पहले इस्तेमाल हो चुकी है?
        const existingTxn = await WalletTransaction.findOne({ razorpayPaymentId: razorpay_payment_id });
        if (existingTxn) {
            return res.status(400).json({ message: 'This payment has already been credited to a wallet' });
        }

        // 4. Update Balance using Verified Amount
        const balanceBefore = user.walletBalance || 0;
        user.walletBalance = balanceBefore + verifiedAmount;

        if (user.role === 'driver' && user.walletBalance >= (global.MIN_DRIVER_BALANCE || 100)) {
            user.isLocked = false;
        }

        await user.save();

        // 5. Log Transaction with Unique Payment ID
        await WalletTransaction.create({
            driver: user.role === 'driver' ? user._id : undefined,
            seller: user.role === 'seller' ? user._id : undefined,
            type: 'Credit',
            amount: verifiedAmount,
            balanceBefore,
            balanceAfter: user.walletBalance,
            razorpayPaymentId: razorpay_payment_id, // इसे Schema में 'unique' रखें
            description: `Wallet Recharge (Verified Txn: ${razorpay_payment_id})`
        });

        res.json({ 
            success: true, 
            message: 'Wallet recharged safely!', 
            newBalance: user.walletBalance 
        });

    } catch (err) {
        console.error("Hacker Prevention Error:", err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
});

// 4. Cancel Ride by User (Rider)
// 4. Cancel Ride (Updated for Village Driver Control)
app.post('/api/ride/cancel', protect, async (req, res) => {
    try {
        const { rideId, reason } = req.body;
        const userId = req.user._id.toString();

        // Populate driver and customer to get FCM tokens for notification
        const ride = await Ride.findById(rideId).populate('driver customer', 'name phone fcmToken');

        if (!ride) return res.status(404).json({ message: 'Ride not found' });

        if (['Completed', 'Cancelled'].includes(ride.status)) {
            return res.status(400).json({ message: 'Ride is already completed or cancelled.' });
        }

        // Check who is cancelling
        const isCustomer = ride.customer._id.toString() === userId;
        const isDriver = ride.driver && ride.driver._id.toString() === userId;

        if (!isCustomer && !isDriver) {
            return res.status(403).json({ message: 'Not authorized to cancel this ride.' });
        }

        // Update Status
        ride.status = 'Cancelled';
        await ride.save();

        // --- SCENARIO A: CUSTOMER CANCELS ---
        if (isCustomer) {
            // Notify Driver if assigned
            if (ride.driver && ride.driver.fcmToken) {
                await sendPushNotification(
                    [ride.driver.fcmToken],
                    'Ride Cancelled ❌',
                    `Customer has cancelled the ride.`,
                    { rideId: ride._id.toString(), type: 'RIDE_CANCELLED' }
                );
            }
            console.log(`👤 Customer ${req.user.name} cancelled Ride #${ride._id}`);
        }

        // --- SCENARIO B: DRIVER CANCELS (Village Control Logic) ---
        if (isDriver) {
            // 1. Notify Customer immediately so they can book another
            if (ride.customer && ride.customer.fcmToken) {
                await sendPushNotification(
                    [ride.customer.fcmToken],
                    'Driver Cancelled ⚠️',
                    `Sorry, driver cancelled the ride. Please request again.`,
                    { rideId: ride._id.toString(), type: 'RIDE_CANCELLED' }
                );
            }

            // 2. Driver Behavior Tracking (Simple Log)
            // Future Update: Add logic here to deduct ₹5 fine or block for 1 hour after 3 cancels
            console.log(`⚠️ Driver ${req.user.name} cancelled Ride #${ride._id}. Reason: ${reason || 'None'}`);
        }

        res.json({ message: 'Ride cancelled successfully' });

    } catch (err) {
        console.error('Cancel Ride Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- RIDE TIMER SETTINGS ---
const RIDE_TIMEOUT_SECONDS = 30; // 30 Seconds Timer

// Helper Function: Auto-Move to Next Driver on Timeout
// Helper Function: Auto-Move to Next Driver on Timeout
const scheduleRideTimeout = (rideId, driverIndexAtStart) => {
    console.log(`⏳ Timer started for Ride ${rideId} (Index: ${driverIndexAtStart}) for ${RIDE_TIMEOUT_SECONDS}s`);

    setTimeout(async () => {
        try {
            const ride = await Ride.findById(rideId);

            // 1. Validation: Stop if ride is no longer valid, accepted, or cancelled
            if (!ride || ride.status !== 'Requested') {
                console.log(`⏹️ Timer stopped for Ride ${rideId}: Status is ${ride ? ride.status : 'Deleted'}`);
                return;
            }

            // 2. Validation: Stop if the driver index changed manually (Driver declined manually)
            if (ride.currentDriverIndex !== driverIndexAtStart) {
                console.log(`⏩ Timer skipped: Driver index changed manually for Ride ${rideId}`);
                return;
            }

            console.log(`⏰ Timeout reached for Ride ${rideId}. Auto-switching to next driver.`);

            // 3. Logic: Add current driver to rejected list & Increment Index
            const currentDriverId = ride.potentialDrivers[ride.currentDriverIndex];
            if (!ride.rejectedDrivers.includes(currentDriverId)) {
                ride.rejectedDrivers.push(currentDriverId);
            }

            ride.currentDriverIndex += 1;

            // 4. Logic: Loop back if end of list
            if (ride.currentDriverIndex >= ride.potentialDrivers.length) {
                console.log(`♻️ All drivers timed out. Looping back to first driver.`);
                ride.currentDriverIndex = 0;
                ride.rejectedDrivers = []; // Optional: Clear rejection to give them another chance
            }

            await ride.save();

            // 5. Notify the NEW Driver (WITH REAL-TIME ONLINE CHECK)
            const nextDriverId = ride.potentialDrivers[ride.currentDriverIndex];
            
            // 🔥 UPDATE: Added 'isOnline' to the select query
            const nextDriver = await User.findById(nextDriverId).select('fcmToken name isOnline');

            // 🔥 UPDATE: Added '&& nextDriver.isOnline' check
            if (nextDriver && nextDriver.isOnline && nextDriver.fcmToken) {
                console.log(`🔔 Notifying Next Driver (Auto): ${nextDriver.name}`);
                await sendPushNotification(
                    [nextDriver.fcmToken],
                    'New Ride Request 🚖',
                    `Ride Available! Earn ₹${ride.estimatedFare}`,
                    { rideId: ride._id.toString(), type: 'NEW_RIDE' }
                );
            } else {
                // Log if skipped due to offline status
                console.log(`⚠️ Driver ${nextDriver ? nextDriver.name : 'Unknown'} is OFFLINE or invalid. Notification skipped.`);
            }

            // 6. RECURSION: Start Timer for the NEW Driver
            // (Timer continues regardless of whether notification was sent, to keep the loop moving)
            scheduleRideTimeout(rideId, ride.currentDriverIndex);

        } catch (err) {
            console.error("❌ Error in Ride Timeout Logic:", err.message);
        }
    }, RIDE_TIMEOUT_SECONDS * 1000);
};


// 🚨 SOS Alert System (Updated: Sends WhatsApp + Saves to DB for Admin Panel)
app.post('/api/ride/sos', protect, async (req, res) => {
    try {
        const { rideId, location } = req.body; // location = "Lat, Lng"
        const user = req.user;

        // 1. Ride details fetch karo (agar available hai)
        let rideInfo = "No Active Ride";
        let driverInfo = "N/A";
        let reportedDriverId = null;

        if (rideId) {
            const ride = await Ride.findById(rideId).populate('driver', 'name phone vehicleType');
            if (ride) {
                rideInfo = `Ride #${ride._id.toString().slice(-4)}`;
                if (ride.driver) {
                    driverInfo = `${ride.driver.name} (${ride.driver.phone}) - ${ride.driver.vehicleType}`;
                    reportedDriverId = ride.driver._id;
                }
            }
        }

        // 2. Admin Alert Message (WhatsApp ke liye)
        const alertMsg = `🚨 *SOS EMERGENCY ALERT!* 🚨\n\n` +
                         `👤 *Sender:* ${user.name} (${user.role.toUpperCase()})\n` +
                         `📞 *Phone:* ${user.phone}\n` +
                         `📍 *Location:* ${location || 'Unknown'}\n` +
                         `🚖 *Ride:* ${rideInfo}\n` +
                         `👮 *Driver:* ${driverInfo}\n\n` +
                         `⚠️ *Action Required Immediately!*`;

        // 3. Admin ko WhatsApp bhejo
        if (process.env.WHATSAPP_ADMIN_NUMBER) {
            await sendWhatsApp(process.env.WHATSAPP_ADMIN_NUMBER, alertMsg);
        }

        // 4. ✅ SAVE TO DATABASE (Critical Step for Admin Panel)
        // Hum 'Complaint' model use kar rahe hain taaki Admin Panel ise fetch kar sake
        await Complaint.create({
            user: user._id,
            ride: rideId || null,
            driver: reportedDriverId, // Agar driver assigned tha
            reason: `SOS EMERGENCY: Location ${location || 'Unknown'}`, // 'SOS' keyword is important for filtering
            status: 'Pending',
            adminNote: 'Emergency alert triggered via App'
        });

        res.json({ message: 'SOS Alert Sent & Recorded!' });

    } catch (err) {
        console.error("SOS Error:", err);
        res.status(500).json({ message: 'Error sending SOS' });
    }
});

// [ADMIN] 1. Get All Drivers (Online/Offline, Location, Balance)
app.get('/api/admin/drivers-status', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const drivers = await User.find({ role: 'driver' })
            .select('name phone isOnline isLocked walletBalance location vehicleType approved lastActiveAt')
            .sort({ isOnline: -1, lastActiveAt: -1 }); // Online pehle dikhenge

        // Format data for simple admin table
        const formatted = drivers.map(d => ({
            id: d._id,
            name: d.name,
            phone: d.phone,
            vehicle: d.vehicleType,
            status: d.isOnline ? '🟢 Online' : '⚪ Offline',
            balance: `₹${d.walletBalance.toFixed(2)}`,
            locked: d.isLocked ? '🔒 Locked' : '✅ Active',
            location: d.location && d.location.coordinates ? 
                `${d.location.coordinates[1]}, ${d.location.coordinates[0]}` : 'Unknown'
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [ADMIN] 2. Get Specific Driver History (Rides + Wallet)
app.get('/api/admin/drivers/:id/details', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const driverId = req.params.id;

        // 1. Last 50 Rides
        const rides = await Ride.find({ driver: driverId })
            .select('pickupLocation dropLocation estimatedFare status createdAt distanceKm')
            .sort({ createdAt: -1 })
            .limit(50);

        // 2. Last 20 Wallet Transactions
        const transactions = await WalletTransaction.find({ driver: driverId })
            .sort({ createdAt: -1 })
            .limit(20);

        // 3. Complaint Count
        const complaintCount = await Complaint.countDocuments({ driver: driverId });

        res.json({
            totalRides: rides.length,
            complaints: complaintCount,
            rideHistory: rides,
            walletHistory: transactions
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [ADMIN] 3. Block or Unblock Driver
app.put('/api/admin/drivers/:id/block', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { action } = req.body; // action = "block" or "unblock"
        const driver = await User.findById(req.params.id);

        if (!driver) return res.status(404).json({ message: 'Driver not found' });

        if (action === 'block') {
            driver.isLocked = true;
            driver.isOnline = false; // Force Offline
            // Optional: Add reason field logic here
        } else {
            driver.isLocked = false;
        }

        await driver.save();
        res.json({ message: `Driver ${action === 'block' ? 'Blocked 🔒' : 'Unblocked ✅'} successfully.` });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [USER] Post a Complaint
app.post('/api/complaints', protect, async (req, res) => {
    try {
        const { rideId, reason, driverId } = req.body;
        
        await Complaint.create({
            user: req.user._id,
            ride: rideId,
            driver: driverId,
            reason: reason
        });

        res.status(201).json({ message: 'Complaint submitted. Support will check shortly.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [ADMIN] Get All Complaints
app.get('/api/admin/complaints', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const complaints = await Complaint.find()
            .populate('user', 'name phone')
            .populate('driver', 'name phone')
            .sort({ createdAt: -1 });

        res.json(complaints);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [ADMIN] Resolve Complaint
app.put('/api/admin/complaints/:id/resolve', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { status, adminNote } = req.body; // status = 'Resolved' or 'Ignored'
        
        await Complaint.findByIdAndUpdate(req.params.id, {
            status: status,
            adminNote: adminNote
        });

        res.json({ message: 'Complaint status updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 👮 Admin Action: Punish Driver (48hr Block or Permanent Ban)
app.post('/api/admin/drivers/:id/punish', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { action, reason } = req.body; // action: 'temp_ban' (48hr) or 'perm_ban'
        const driver = await User.findById(req.params.id);

        if (!driver) return res.status(404).json({ message: 'Driver not found' });

        if (action === 'temp_ban') {
            // 👉 CASE 1: Jhagda/Abuse -> 48 Hours Block
            const expiryDate = new Date();
            expiryDate.setHours(expiryDate.getHours() + 48); // Add 48 Hours

            driver.isLocked = true;
            driver.isOnline = false; // Turant Offline karo
            driver.lockExpiresAt = expiryDate;
            driver.blockReason = reason || "Abusive Behavior (48h Ban)";
            
            await sendWhatsApp(driver.phone, `⚠️ You are blocked for 48 HOURS due to: ${driver.blockReason}. Contact Admin.`);
        
        } else if (action === 'perm_ban') {
            // 👉 CASE 2: Customer Misbehavior -> Permanent Block
            driver.isLocked = true;
            driver.isOnline = false;
            driver.approved = false; // Login hi band ho jayega
            driver.lockExpiresAt = null; // Permanent hai
            driver.blockReason = reason || "Severe Misconduct (Permanent Ban)";

            await sendWhatsApp(driver.phone, `🛑 ACCOUNT TERMINATED. Reason: ${driver.blockReason}. You cannot drive anymore.`);
        } else {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        await driver.save();
        res.json({ message: `Driver punished: ${action}`, driverStatus: driver.isLocked });

    } catch (err) {
        console.error("Punish Driver Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ✅ NEW: Get Home Layout & Theme
// ✅ NEW: Get Home Layout & Theme (Flipkart Style)
app.get('/api/home/layout', async (req, res) => {
  try {
    // 1. Settings (Colors) layein
    let settings = await AppSettings.findOne({ singleton: true });
    if (!settings) {
       settings = await AppSettings.create({ singleton: true }); // Default bana dein agar nahi hai
    }

    // 2. Categories layein (Sorted)
    // ✅ Added 'borderColor' to select
    const categories = await Category.find({ isActive: true })
      .sort({ sortOrder: 1 })
      .select('name image slug type bgColor textColor shape borderColor'); 

    // 3. Banners layein
    const banners = await Banner.find({ isActive: true, position: 'top' });

    // 4. Response structure (Flipkart Style JSON)
    res.json({
      theme: settings.theme, // Global Colors (App Bar, Background)
      layout: [
        {
          type: 'search_bar',
          backgroundColor: settings.theme.searchBarColor
        },
        {
          type: 'category_grid',
          data: categories, // Isme har category ka color/shape hoga
          backgroundColor: '#FFFFFF'
        },
        {
          type: 'hero_banner',
          data: banners,
          aspectRatio: 2.5 // Example: Banner ki height control karne ke liye
        }
        // Aap yahan aur sections add kar sakte hain (e.g., 'horizontal_list')
      ]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error fetching home layout' });
  }
});

// ---------------------------------------------------------
// 🤖 AI RECOMMENDATION: Popular Items in User's Area
// ---------------------------------------------------------
app.get('/api/products/recommendations/area-popular', protect, async (req, res) => {
    try {
        // 1. Pincode निकालें (Query से या User Profile से)
        const userPincode = req.query.pincode || (req.user.pincodes && req.user.pincodes.length > 0 ? req.user.pincodes[0] : null);

        if (!userPincode) {
            // अगर पिनकोड नहीं है, तो सिर्फ Trending प्रोडक्ट्स भेजें
            const globalTrending = await Product.find({ isTrending: true, stock: { $gt: 0 } }).limit(10);
            return res.json(globalTrending);
        }

        // 2. Aggregation: उस Pincode के Orders को स्कैन करें
        const popularProducts = await Order.aggregate([
            {
                $match: {
                    pincode: userPincode,           // 1. सिर्फ इस एरिया के आर्डर
                    paymentStatus: 'completed',     // 2. सिर्फ कन्फर्म आर्डर
                    deliveryStatus: { $ne: 'Cancelled' }
                }
            },
            { $unwind: "$orderItems" }, // 3. आर्डर के हर आइटम को अलग करें
            {
                $group: {
                    _id: "$orderItems.product", // 4. प्रोडक्ट वाइज ग्रुप करें
                    totalSold: { $sum: "$orderItems.qty" } // 5. टोटल क्वांटिटी गिनें
                }
            },
            { $sort: { totalSold: -1 } }, // 6. सबसे ज्यादा बिकने वाला ऊपर
            { $limit: 10 }, // 7. टॉप 10 आइटम निकालें
            {
                $lookup: { // 8. प्रोडक्ट की डिटेल्स जोड़ें (Name, Image, Price)
                    from: "products",
                    localField: "_id",
                    foreignField: "_id",
                    as: "productInfo"
                }
            },
            { $unwind: "$productInfo" },
            {
                $project: { // 9. डेटा को सही फॉर्मेट में भेजें
                    _id: "$productInfo._id",
                    name: "$productInfo.name",
                    images: "$productInfo.images",
                    // पहला वेरिएंट प्राइस दिखाने के लिए
                    price: { $arrayElemAt: ["$productInfo.variants.price", 0] }, 
                    originalPrice: { $arrayElemAt: ["$productInfo.variants.originalPrice", 0] },
                    unit: "$productInfo.unit",
                    totalSold: 1
                }
            }
        ]);

        // 3. Fallback Logic:
        // अगर एरिया नया है और वहां < 5 पॉपुलर आइटम हैं, तो Global Trending प्रोडक्ट्स मिक्स करें
        if (popularProducts.length < 5) {
            const idsToExclude = popularProducts.map(p => p._id);
            
            const globalTrending = await Product.find({ 
                isTrending: true, 
                stock: { $gt: 0 },
                _id: { $nin: idsToExclude } // जो पहले से लिस्ट में हैं उन्हें दोबारा न जोड़ें
            })
            .limit(10 - popularProducts.length)
            .select('name images variants unit');

            // ग्लोबल डाटा को फॉर्मेट करें ताकि वह ऊपर वाले डाटा जैसा दिखे
            const formattedGlobal = globalTrending.map(p => ({
                _id: p._id,
                name: p.name,
                images: p.images,
                price: p.variants[0]?.price,
                originalPrice: p.variants[0]?.originalPrice,
                unit: p.unit,
                tag: 'Trending' // इसे हम UI में दिखा सकते हैं
            }));

            // दोनों लिस्ट को मिला दें
            return res.json([...popularProducts, ...formattedGlobal]);
        }

        res.json(popularProducts);

    } catch (err) {
        console.error("AI Recommendation Error:", err.message);
        res.status(500).json({ message: "Error fetching recommendations" });
    }
});

// ✅ NEW: Approve or Reject a Product
app.put('/api/admin/products/:id/approval', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { isApproved } = req.body; // Expects boolean true/false
    const productId = req.params.id;

    const product = await Product.findByIdAndUpdate(
        productId, 
        { isApproved: isApproved }, 
        { new: true }
    ).populate('seller', 'phone fcmToken name');

    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Notify Seller
    if (product.seller) {
        const statusMsg = isApproved ? 'Approved ✅' : 'Rejected ❌';
        const msg = `Your product "${product.name}" has been ${statusMsg} by the admin.`;
        
        // Send WhatsApp
        if (product.seller.phone) {
            await sendWhatsApp(product.seller.phone, msg);
        }
        // Send Push
        if (product.seller.fcmToken) {
            await sendPushNotification(
                [product.seller.fcmToken],
                `Product ${statusMsg}`,
                msg,
                { type: 'PRODUCT_STATUS' }
            );
        }
    }

    res.json({ message: `Product marked as ${isApproved ? 'Approved' : 'Pending/Rejected'}`, product });

  } catch (err) {
    res.status(500).json({ message: 'Error updating product approval status', error: err.message });
  }
});

// ✅ GET: Peak Order Time Analysis (For Sellers)
app.get('/api/seller/analytics/peak-time', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const peakTimes = await Order.aggregate([
            { $match: { seller: req.user._id, paymentStatus: 'completed' } },
            {
                $project: {
                    hour: { $hour: "$createdAt" }, // Extract hour (0-23)
                    dayOfWeek: { $dayOfWeek: "$createdAt" } // 1 (Sun) - 7 (Sat)
                }
            },
            {
                $group: {
                    _id: "$hour",
                    count: { $sum: 1 }
                }
            },
            { $sort: { count: -1 } }, // Highest orders first
            { $limit: 5 }
        ]);

        // Map hours to readable format (e.g., 14 -> "2 PM")
        const formatted = peakTimes.map(pt => ({
            hour: pt._id,
            label: new Date(0, 0, 0, pt._id).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
            orders: pt.count
        }));

        res.json({ peakTimes: formatted });
    } catch (err) {
        res.status(500).json({ message: 'Error analyzing peak times', error: err.message });
    }
});

// ✅ GET: High Demand Products Alert (Velocity Check)
app.get('/api/seller/alerts/high-demand', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const highDemandProducts = await Order.aggregate([
            { 
                $match: { 
                    seller: req.user._id, 
                    createdAt: { $gte: twentyFourHoursAgo },
                    paymentStatus: 'completed'
                } 
            },
            { $unwind: "$orderItems" },
            {
                $group: {
                    _id: "$orderItems.product",
                    salesLast24h: { $sum: "$orderItems.qty" }
                }
            },
            { $match: { salesLast24h: { $gte: 5 } } }, // Threshold: 5+ sales in 24h = High Demand
            {
                $lookup: {
                    from: 'products',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'product'
                }
            },
            { $unwind: "$product" },
            {
                $project: {
                    name: "$product.name",
                    salesLast24h: 1,
                    image: { $arrayElemAt: ["$product.images.url", 0] }
                }
            }
        ]);

        res.json(highDemandProducts);
    } catch (err) {
        res.status(500).json({ message: 'Error checking demand', error: err.message });
    }
});

// ✅ POST: Boost Product (Paid Feature)
// Seller pays ₹50 to mark product as "Trending" for 7 days
app.post('/api/seller/products/:id/boost', protect, authorizeRole('seller'), async (req, res) => {
    const BOOST_COST = 50; 
    const DURATION_DAYS = 7;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const seller = await User.findById(req.user._id).session(session);
        if (seller.walletBalance < BOOST_COST) {
            await session.abortTransaction();
            return res.status(400).json({ message: `Insufficient wallet balance. Recharge ₹${BOOST_COST} to boost.` });
        }

        // 1. Deduct Money
        seller.walletBalance -= BOOST_COST;
        await seller.save({ session });

        // 2. Update Product
        const product = await Product.findOneAndUpdate(
            { _id: req.params.id, seller: seller._id },
            { isTrending: true }, // Mark as Trending/Featured
            { new: true, session }
        );

        if (!product) {
            await session.abortTransaction();
            return res.status(404).json({ message: 'Product not found.' });
        }

        // 3. Log Transaction
        await WalletTransaction.create([{
            seller: seller._id,
            type: 'Debit',
            amount: BOOST_COST,
            balanceBefore: seller.walletBalance + BOOST_COST,
            balanceAfter: seller.walletBalance,
            description: `Product Boost: ${product.name} (7 Days)`
        }], { session });

        await session.commitTransaction();

        // 4. Schedule auto-removal of boost (Optional: Use cron for persistence)
        // For simplicity, we assume a nightly cron job will uncheck 'isTrending' after 7 days
        // based on a 'boostExpiresAt' field (add this to schema if strict tracking needed).

        res.json({ message: `Product boosted successfully! ₹${BOOST_COST} deducted.`, newBalance: seller.walletBalance });

    } catch (err) {
        await session.abortTransaction();
        res.status(500).json({ message: 'Error boosting product', error: err.message });
    } finally {
        session.endSession();
    }
});

// ✅ POST: Create Seller Coupon
app.post('/api/seller/coupons', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const { code, discountType, discountValue, minPurchaseAmount, expiryDate } = req.body;
        
        const newCoupon = await Coupon.create({
            code: code.toUpperCase(),
            discountType,
            discountValue,
            minPurchaseAmount: minPurchaseAmount || 0,
            expiryDate,
            seller: req.user._id, // Locked to this seller
            isActive: true
        });

        res.status(201).json(newCoupon);
    } catch (err) {
        res.status(500).json({ message: 'Error creating coupon', error: err.message });
    }
});

// ✅ GET: Check & Update Trust Score
app.get('/api/seller/trust-score', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const sellerId = req.user._id;

        // 1. Calculate Average Rating from Reviews
        // (Assuming Review model has product reference, we look up products by seller)
        const sellerProducts = await Product.find({ seller: sellerId }).select('_id');
        const productIds = sellerProducts.map(p => p._id);

        const ratingStats = await Review.aggregate([
            { $match: { product: { $in: productIds } } },
            { $group: { _id: null, avgRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } }
        ]);

        const avgRating = ratingStats[0]?.avgRating || 0;
        const totalReviews = ratingStats[0]?.totalReviews || 0;

        // 2. Calculate Order Completion Rate
        const totalOrders = await Order.countDocuments({ seller: sellerId });
        const cancelledOrders = await Order.countDocuments({ seller: sellerId, deliveryStatus: 'Cancelled' });
        
        let completionRate = 100;
        if (totalOrders > 0) {
            completionRate = ((totalOrders - cancelledOrders) / totalOrders) * 100;
        }

        // 3. Determine Trust Badge
        // Criteria: 4.0+ Rating, 10+ Reviews, 90%+ Completion Rate
        let isTrusted = false;
        if (avgRating >= 4.0 && totalReviews >= 10 && completionRate >= 90) {
            isTrusted = true;
        }

        // Update User Profile
        const seller = await User.findById(sellerId);
        seller.sellerScore = Math.round((avgRating * 20) + (completionRate * 0.5)); // Simple score logic
        seller.isTrustedSeller = isTrusted;
        await seller.save();

        res.json({
            avgRating: avgRating.toFixed(1),
            totalReviews,
            completionRate: completionRate.toFixed(1) + '%',
            isTrusted,
            score: seller.sellerScore
        });

    } catch (err) {
        res.status(500).json({ message: 'Error calculating trust score', error: err.message });
    }
});

// ✅ Corrected Route: /api/print/upload
// ✅ FIXED ROUTE: /api/print/upload
// Now accepts 'sellerId' to prevent the crash
app.post('/api/print/upload', protect, uploadPrint.single('file'), async (req, res) => {
  try {
    // 1. Extract Seller ID (Check both keys to be safe)
    const sellerId = req.body.sellerId || req.body.seller;

    // 2. Validation
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    // CRITICAL FIX: Ensure sellerId is present
    if (!sellerId) {
      console.error("❌ Upload Error: Missing Seller ID in request body.");
      return res.status(400).json({ message: 'Seller ID is required for upload.' });
    }

    // 3. Create PrintJob
    const newPrintJob = await PrintJob.create({
      user: req.user._id,
      seller: sellerId, // ✅ THIS LINE FIXES YOUR CRASH
      originalName: req.file.originalname,
      fileUrl: req.file.path, // Cloudinary URL
      publicId: req.file.filename,
      status: 'Pending',      // Add default status
      paymentStatus: 'pending'
    });

    res.status(201).json({
      message: 'File converted to PDF and uploaded successfully.',
      fileUrl: newPrintJob.fileUrl, 
      printJob: newPrintJob
    });

  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).json({ message: 'Error uploading print job', error: err.message });
  }
});
app.get('/api/admin/print/queue', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const jobs = await PrintJob.find().populate('user', 'name phone').sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching queue' });
  }
});

app.post('/api/seller/printable-forms', protect, authorizeRole('seller', 'admin'), uploadPrint.single('file'), async (req, res) => {
  try {
    const { title, description, priceBW, priceColor, category } = req.body;
    
    const newForm = await PrintableForm.create({
      seller: req.user._id,
      title,
      description,
      pricePerCopyBW: parseFloat(priceBW),
      pricePerCopyColor: parseFloat(priceColor),
      category,
      fileUrl: req.file.path,
      publicId: req.file.filename
    });

    res.status(201).json({ message: 'Form/Book uploaded successfully', newForm });
  } catch (err) {
    res.status(500).json({ message: 'Error uploading form', error: err.message });
  }
});

app.post('/api/print/order-form', protect, async (req, res) => {
  try {
    const { formId, printType, quantity } = req.body;

    const form = await PrintableForm.findById(formId);
    if (!form) return res.status(404).json({ message: 'Form not found' });

    // रेट कैलकुलेशन
    const rate = (printType === 'Color') ? form.pricePerCopyColor : form.pricePerCopyBW;
    const totalAmount = rate * parseInt(quantity);

    // 1. Razorpay Order बनाएँ
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100),
      currency: "INR",
      receipt: `form_print_${Date.now()}`
    });

    // 2. Print Job बनाएँ (सेलर के पहले से अपलोडेड फाइल का उपयोग करके)
    const printJob = await PrintJob.create({
      user: req.user._id,
      fileUrl: form.fileUrl, // सेलर की फाइल का लिंक यहाँ कॉपी होगा
      pages: quantity,      // यहाँ क्वांटिटी का मतलब पेज या कॉपी से है
      printType,
      amount: totalAmount,
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: 'pending'
    });

    res.json({ printJob, razorpayOrder });
  } catch (err) {
    res.status(500).json({ message: 'Error ordering form print', error: err.message });
  }
});

app.post('/api/print/order-request', protect, async (req, res) => {
  try {
    const { sellerId, pages, printType, addressId } = req.body;

    const settings = await AppSettings.findOne({ singleton: true });
    const seller = await User.findById(sellerId);

    // 1. चेक करें कि सेलर अप्रूव्ड है या नहीं
    if (!seller || !seller.isPrintServiceApproved) {
      return res.status(403).json({ message: "Seller not approved for print services." });
    }

    // 2. एडमिन रेट के हिसाब से प्रिंटिंग कॉस्ट
    const rate = (printType === 'Color') ? settings.printConfig.colorRatePerPage : settings.printConfig.bwRatePerPage;
    const printCost = rate * pages;

    // 3. डिलीवरी चार्ज कैलकुलेशन (Distance Based)
    const address = await Address.findById(addressId);
    const dist = getDistanceFromLatLonInKm(address.lat, address.lng, seller.location.coordinates[1], seller.location.coordinates[0]);
    const deliveryFee = getDynamicDeliveryFee(dist, settings.deliveryConfig);

    const grandTotal = printCost + deliveryFee;

    // 4. कमीशन और सेलर का हिस्सा (Calculation only)
    const adminPart = printCost * settings.printConfig.adminPrintCommission;
    const sellerPart = printCost - adminPart;

    // 5. Razorpay Order
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(grandTotal * 100),
      currency: "INR",
      receipt: `prnt_${Date.now()}`
    });

    res.json({ razorpayOrder, grandTotal, sellerPart });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
app.put('/api/admin/print/settle-payout/:jobId', protect, authorizeRole('admin'), async (req, res) => {
  try {
    const { transactionId } = req.body; 
    
    const printJob = await PrintJob.findById(req.params.jobId).populate('seller');

    if (!printJob) return res.status(404).json({ message: "Job not found" });

    // 1. सुरक्षा जांच: कहीं पैसा पहले ही तो नहीं भेजा जा चुका?
    if (printJob.payoutStatus === 'Settled') {
      return res.status(400).json({ message: "This payout is already settled." });
    }

    if (printJob.paymentStatus !== 'completed') {
      return res.status(400).json({ message: "User hasn't paid yet" });
    }

    // 2. डेटा अपडेट करें
    printJob.payoutStatus = 'Settled';
    printJob.transactionId = transactionId;
    printJob.settledAt = Date.now();
    await printJob.save();

    // 3. सेलर की ट्रांजैक्शन हिस्ट्री में रिकॉर्ड जोड़ें (Future reference के लिए)
    await WalletTransaction.create({
      seller: printJob.seller._id,
      type: 'Direct_Credit', // टैग ताकि पता चले कि यह सीधा बैंक में गया है
      amount: printJob.sellerEarnings,
      description: `Manual Payout for Print #${printJob._id.toString().slice(-6)}. Ref: ${transactionId}`
    });

    // 4. सेलर को नोटिफिकेशन भेजें
    if (printJob.seller.fcmToken) {
      await sendPushNotification(
        printJob.seller.fcmToken, 
        "💰 Payment Received", 
        `Admin sent ₹${printJob.sellerEarnings} to your Bank/UPI. Ref: ${transactionId}`
      );
    }

    res.json({ 
      success: true, 
      message: "Payout marked as settled successfully", 
      utr: transactionId 
    });

  } catch (err) {
    res.status(500).json({ message: 'Settlement Error', error: err.message });
  }
});

// ✅ NEW ROUTE: Submit Print Job (Matches Flutter App)
// ✅ NEW ROUTE: Submit Print Job (Fixed & Cleaned)
// ✅ FULL UPDATED ROUTE: Submit Print Job (With Robust Seller Notifications)
app.post('/api/print/jobs', protect, uploadPrint.single('document'), async (req, res) => {
  try {
    console.log("📥 Print Job Request Body:", req.body); 

    // 1. Extract Data (Robust check for sellerId)
    const sellerId = req.body.sellerId || req.body.seller; 
    const { copies, printType, sideType, paperSize, instructions } = req.body;

    // 2. Validation Checks
    if (!req.file) {
      return res.status(400).json({ message: 'No document file uploaded' });
    }
    
    if (!sellerId) {
      console.error("❌ FAILURE: Seller ID is missing.");
      return res.status(400).json({ message: "Seller ID is required." });
    }

    // 3. Fetch App Settings for Pricing
    const settings = await AppSettings.findOne({ singleton: true });
    const bwRate = settings?.printConfig?.bwRatePerPage || 2;
    const colorRate = settings?.printConfig?.colorRatePerPage || 10;
    const adminCommissionRate = settings?.printConfig?.adminPrintCommission || 0.10;

    // 4. Calculate Cost
    const numCopies = parseInt(copies) || 1;
    const isColor = printType && printType.toLowerCase() === 'color';
    const rate = isColor ? colorRate : bwRate;
    
    const totalCost = rate * numCopies; 
    const adminShare = totalCost * adminCommissionRate;
    const sellerShare = totalCost - adminShare;

    // 5. Create Job in DB
    const newJob = await PrintJob.create({
      user: req.user._id,
      seller: sellerId,
      originalName: req.file.originalname,
      fileUrl: req.file.path,
      publicId: req.file.filename,
      copies: numCopies,
      printType,
      sideType,
      paperSize,
      instructions,
      printCost: totalCost,
      sellerEarnings: sellerShare,
      status: 'Pending',
      paymentStatus: 'pending'
    });

    console.log("✅ Print Job Created Successfully:", newJob._id);

    // 6. ✅ DETAILED NOTIFICATION LOGIC (Updated for WhatsApp & Push)
    // Hum seller ka 'phone' aur 'fcmToken' dono fetch karenge
    const sellerUser = await User.findById(sellerId).select('phone fcmToken name');
    
    if (sellerUser) {
        const sellerPushMsg = `New Print Job! 🖨️ Earn ₹${sellerShare.toFixed(2)}`;
        const sellerWhatsAppMsg = `🖨️ *New Print Request!*\n\n` +
                                  `📄 File: ${req.file.originalname}\n` +
                                  `🔢 Copies: ${numCopies}\n` +
                                  `🎨 Type: ${printType.toUpperCase()}\n` +
                                  `💰 Earnings: ₹${sellerShare.toFixed(2)}\n\n` +
                                  `Check dashboard to process.`;

        // A. Send WhatsApp
        if (sellerUser.phone) {
            await sendWhatsApp(sellerUser.phone, sellerWhatsAppMsg);
        }

        // B. Send Push Notification (Ensure token is in array)
        if (sellerUser.fcmToken) {
            await sendPushNotification(
                [sellerUser.fcmToken], 
                'New Print Job! 🖨️', 
                sellerPushMsg, 
                { jobId: newJob._id.toString(), type: 'NEW_PRINT_JOB' }
            );
        }
    }

    // 7. Send Response
    res.status(201).json({
      success: true,
      message: 'Print job submitted successfully',
      job: newJob
    });

  } catch (err) {
    console.error('❌ Print Job Error:', err);
    res.status(500).json({ message: 'Error submitting print job', error: err.message });
  }
});

// ✅ GET: Get Incoming Print Jobs for Seller (Missing Route)
app.get('/api/print/seller-jobs', protect, authorizeRole('seller', 'admin'), async (req, res) => {
  try {
    const jobs = await PrintJob.find({ seller: req.user._id })
      .populate('user', 'name phone') // ग्राहक का नाम और फोन नंबर दिखाएं
      .sort({ createdAt: -1 }); // सबसे नए जॉब्स पहले
    res.json(jobs);
  } catch (err) {
    console.error('Error fetching seller print jobs:', err.message);
    res.status(500).json({ message: 'Error fetching print jobs', error: err.message });
  }
});

// ✅ GET: Get My Print Jobs (For Customer App - Optional but Recommended)
app.get('/api/print/my-jobs', protect, async (req, res) => {
  try {
    const jobs = await PrintJob.find({ user: req.user._id })
      .populate('seller', 'name phone')
      .sort({ createdAt: -1 });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching my print jobs', error: err.message });
  }
});

// ✅ PATCH: Update Print Job Status (For Seller to Mark as Printed/Rejected)
app.patch('/api/print/jobs/:id/status', protect, authorizeRole('seller', 'admin'), async (req, res) => {
  try {
    const { status } = req.body; // 'Printed', 'Rejected'
    const jobId = req.params.id;

    const job = await PrintJob.findOne({ _id: jobId, seller: req.user._id });
    
    if (!job) {
      return res.status(404).json({ message: 'Print job not found or unauthorized.' });
    }

    job.status = status;
    
    // अगर पेमेंट हो चुका है और जॉब कम्पलीट हो गई, तो इसे 'settled' के लिए तैयार मान सकते हैं 
    // (हालांकि payoutStatus अलग है, यह सिर्फ ट्रैकिंग के लिए है)
    
    await job.save();

    // ग्राहक को नोटिफिकेशन भेजें
    const customer = await User.findById(job.user).select('fcmToken phone');
    if (customer) {
        const msg = status === 'Printed' 
            ? `✅ Your document is printed and ready!` 
            : `❌ Your print job was rejected by the seller.`;
            
        if (customer.fcmToken) {
            await sendPushNotification([customer.fcmToken], 'Print Update 🖨️', msg, { type: 'PRINT_UPDATE' });
        }
    }

    res.json({ message: `Job status updated to ${status}`, job });

  } catch (err) {
    console.error('Error updating print job status:', err.message);
    res.status(500).json({ message: 'Error updating status', error: err.message });
  }
});
// ✅ GET: Find Print/Xerox Shops by Pincode (For Auto-Selection)
// ✅ GET: Find APPROVED Print/Xerox Shops by Pincode (Updated Logic)
app.get('/api/sellers/print-shops/:pincode', async (req, res) => {
  try {
    const { pincode } = req.params;
    
    const shops = await User.find({
        role: 'seller',
        approved: true, // सेलर का अकाउंट एक्टिव होना चाहिए
        
        // 🔒 IMPORTANT: सिर्फ वही दिखेंगे जिसे एडमिन ने 'Approved' किया है
        printServiceStatus: 'Approved', 

        $or: [
            { pincodes: pincode },        // या तो पिनकोड मैच हो
            { pincodes: { $size: 0 } }    // या वो ग्लोबल सेलर हो (जो हर जगह डिलीवर करता है)
        ]
    }).select('name phone pickupAddress pincodes printServiceStatus');

    res.json(shops);

  } catch (err) {
    console.error('Error finding shops:', err.message);
    res.status(500).json({ message: 'Error finding shops', error: err.message });
  }
});
// ==========================================
// 🖨️ PRINT SERVICE HELPER ROUTE (AUTO-SETUP)
// ==========================================

// ✅ Get or Create "Print Service" Product ID for a Seller
// ==========================================
// 🖨️ PRINT SERVICE HELPER ROUTE (AUTO-SETUP - FIXED)
// ==========================================

app.get('/api/print/config/:sellerId', async (req, res) => {
  try {
    const { sellerId } = req.params;
    
    // 1. चेक करें कि क्या प्रोडक्ट पहले से मौजूद है?
    let product = await Product.findOne({ seller: sellerId, name: 'Print Service' });
    if (product) return res.json({ productId: product._id });

    // 2. कैटेगरी चेक करें या बनाएं
    let category = await Category.findOne({ $or: [{ name: 'Services' }, { type: 'service' }] });
    
    if (!category) {
        category = await Category.create({ 
            name: 'Services', 
            slug: 'services', // ✅ FIXED: Slug जरूरी है
            type: 'service', 
            isActive: true,
            image: { url: 'https://cdn-icons-png.flaticon.com/512/1067/1067566.png' } 
        });
    }

    // 3. अब 'Print Service' प्रोडक्ट बनाएं (सही Schema Format के साथ)
    product = await Product.create({
        seller: sellerId,
        name: 'Print Service',
        sku: `PRINT-${sellerId.slice(-4)}-${Date.now()}`, // Unique SKU
        brand: 'QuickSauda',
        shortDescription: 'Xerox / Document Printing',
        fullDescription: 'High quality document printing service.',
        unit: 'pcs', // Valid Unit from Enum
        category: category._id,
        isGlobal: true,
        isApproved: true, // Auto Approve
        
        // ✅ FIXED: Variants array जोड़ना जरूरी है क्योंकि price/stock अब इसके अंदर है
        variants: [{
            price: 1,      // Dummy price (असली price printMeta से आएगा)
            stock: 999999, // कभी खत्म न हो
            color: 'Default',
            size: 'A4'
        }]
    });

    console.log(`✅ Auto-created Print Product for Seller ${sellerId}`);
    res.json({ productId: product._id });

  } catch (err) {
    console.error("Print Config Error:", err);
    res.status(500).json({ message: "Failed to setup print service", error: err.message });
  }
});
// ==========================================
// 🛡️ PRINT PERMISSION ROUTES
// ==========================================

// 1. Seller: Request Permission (सेलर रिक्वेस्ट भेजेगा)
app.post('/api/seller/print-request', protect, authorizeRole('seller'), async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        
        if (user.printServiceStatus === 'Approved') {
            return res.status(400).json({ message: 'You are already approved for printing!' });
        }
        
        if (user.printServiceStatus === 'Pending') {
            return res.status(400).json({ message: 'Request already sent. Please wait for admin.' });
        }

        user.printServiceStatus = 'Pending'; // रिक्वेस्ट पेंडिंग में डालें
        await user.save();

        res.json({ message: 'Print service permission requested. Wait for admin approval.', status: 'Pending' });

    } catch (err) {
        res.status(500).json({ message: 'Error requesting permission', error: err.message });
    }
});

// 2. Admin: Approve/Reject Seller (एडमिन अप्रूव करेगा)
app.patch('/api/admin/seller-print-status', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const { sellerId, status } = req.body; // status = 'Approved' or 'Rejected'

        if (!['Approved', 'Rejected', 'None'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const seller = await User.findById(sellerId);
        if (!seller) return res.status(404).json({ message: 'Seller not found' });

        seller.printServiceStatus = status;
        
        // अगर अप्रूव हुआ, तो 'Print Service' प्रोडक्ट चेक करें या बना दें (Auto-Setup Logic)
        if (status === 'Approved') {
             // (वही लॉजिक जो हमने पिछले स्टेप में auto-create के लिए लिखा था, उसे एक फंक्शन बनाकर यहाँ कॉल कर सकते हैं)
             // फ़िलहाल बस स्टेटस अपडेट करते हैं
        }

        await seller.save();

        // सेलर को नोटिफिकेशन भेजें
        if (seller.fcmToken) {
            const msg = status === 'Approved' 
                ? '🎉 Congratulations! Your Print Service is approved by Admin.' 
                : '❌ Your Print Service request was rejected.';
            await sendPushNotification([seller.fcmToken], 'Print Service Update', msg);
        }

        res.json({ message: `Seller print status updated to ${status}`, seller });

    } catch (err) {
        res.status(500).json({ message: 'Error updating status', error: err.message });
    }
});

// 3. Admin: Get List of Pending Requests (एडमिन को लिस्ट दिखाने के लिए)
app.get('/api/admin/print-requests', protect, authorizeRole('admin'), async (req, res) => {
    try {
        const sellers = await User.find({ 
            role: 'seller', 
            printServiceStatus: 'Pending' 
        }).select('name email phone printServiceStatus');
        
        res.json(sellers);
    } catch (err) {
        res.status(500).json({ message: 'Error fetching requests' });
    }
});
// ============================================================
// 📥 PROXY DOWNLOAD ROUTE (Fixes CORS Error)
// ============================================================
// ============================================================
// 📥 PROXY DOWNLOAD ROUTE (Fixes PDF Download Issues)
// ============================================================
// ============================================================
// 📥 PROXY DOWNLOAD ROUTE (Enhanced Debugging)
// ============================================================
const https = require('https');
const http = require('http');

app.get('/api/print/download-proxy', (req, res) => {
    const { url, filename } = req.query;

    if (!url) return res.status(400).send("Missing URL");

    console.log(`📥 Fetching PDF Proxy: ${url}`); // ✅ Check Console Log

    const fetchFile = (fileUrl) => {
        const client = fileUrl.startsWith('https') ? https : http;

        client.get(fileUrl, (response) => {
            // 🔄 Redirect Handling
            if ([301, 302].includes(response.statusCode)) {
                if (response.headers.location) {
                    console.log("🔀 Redirecting to:", response.headers.location);
                    return fetchFile(response.headers.location);
                }
            }

            // ❌ Error Handling (Main Issue Source)
            if (response.statusCode !== 200) {
                console.error(`❌ FAILED: ${response.statusCode} - ${fileUrl}`); // ✅ यह बताएगा कि क्यों फेल हुआ
                if (!res.headersSent) {
                    return res.status(400).send(`Error: Source returned ${response.statusCode}. File may not exist.`);
                }
                return;
            }

            // ✅ Success
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="${filename || 'document.pdf'}"`);
            response.pipe(res);

        }).on('error', (err) => {
            console.error("❌ Network Error:", err.message);
            if (!res.headersSent) res.status(500).send("Server Error fetching file");
        });
    };

    fetchFile(url);
});

// ==========================================
// 📚 PRINT LIBRARY ROUTES
// ==========================================

// 1. [SELLER] Upload a File to Library
app.post('/api/seller/print-library', protect, authorizeRole('seller', 'admin'), uploadPrint.single('file'), async (req, res) => {
    try {
        const { title, description, category, totalPages, pricePerCopy } = req.body;
        
        if (!req.file) return res.status(400).json({ message: "PDF file is required" });

        const newFile = await PrintLibrary.create({
            seller: req.user._id,
            title,
            description,
            category,
            totalPages: Number(totalPages) || 1,
            pricePerCopy: Number(pricePerCopy) || 0,
            fileUrl: req.file.path,
            publicId: req.file.filename
        });

        res.status(201).json({ message: "File added to library", file: newFile });
    } catch (err) {
        res.status(500).json({ message: "Error uploading file", error: err.message });
    }
});

// 2. [SELLER] Get My Library Files
app.get('/api/seller/print-library', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const files = await PrintLibrary.find({ seller: req.user._id }).sort({ createdAt: -1 });
        res.json(files);
    } catch (err) {
        res.status(500).json({ message: "Error fetching library" });
    }
});

// 3. [SELLER] Delete File
app.delete('/api/seller/print-library/:id', protect, authorizeRole('seller', 'admin'), async (req, res) => {
    try {
        const file = await PrintLibrary.findOne({ _id: req.params.id, seller: req.user._id });
        if (!file) return res.status(404).json({ message: "File not found" });

        if (file.publicId) await cloudinary.uploader.destroy(file.publicId);
        await file.deleteOne();
        
        res.json({ message: "File deleted" });
    } catch (err) {
        res.status(500).json({ message: "Error deleting file" });
    }
});

// 4. [USER] Get Library Files of a Specific Seller (For App)
app.get('/api/print/library/:sellerId', async (req, res) => {
    try {
        const files = await PrintLibrary.find({ 
            seller: req.params.sellerId, 
            isActive: true 
        }).select('-publicId'); // Hide internal ID
        
        res.json(files);
    } catch (err) {
        res.status(500).json({ message: "Error fetching seller library" });
    }
});

// Node.js example to generate shareable metadata

app.get('/product-share/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).send("Product not found");
        }

        // Image check: Agar array hai toh pehli image, aur handle object structure
        const imageUrl = product.images && product.images.length > 0 
            ? (typeof product.images[0] === 'object' ? product.images[0].url : product.images[0])
            : 'https://desibazaar0.netlify.app/logo.png'; // Default logo fallback

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>${product.name} | Quick Sauda</title>
                    
                    <meta property="og:title" content="${product.name}" />
                    <meta property="og:description" content="Kharidiye ${product.name} sirf ₹${product.price} mein! Quick Sauda par behtareen deals." />
                    <meta property="og:image" content="${imageUrl}" />
                    <meta property="og:url" content="https://desibazaar0.netlify.app/product/${req.params.id}" />
                    <meta property="og:type" content="product" />
                    <meta property="og:site_name" content="Quick Sauda">
                    
                    <meta name="twitter:card" content="summary_large_image">
                    <meta name="twitter:title" content="${product.name}">
                    <meta name="twitter:description" content="Buy on Quick Sauda">
                    <meta name="twitter:image" content="${imageUrl}">

                    <style>
                        body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; background: #f8f9fa; }
                        .loader { border: 4px solid #f3f3f3; border-top: 4px solid #004aad; border-radius: 50%; width: 40px; height: 40px; animation: spin 2s linear infinite; margin-bottom: 10px; }
                        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    </style>
                </head>
                <body>
                    <div>
                        <div class="loader"></div>
                        <h3>Opening Quick Sauda App...</h3>
                        <p>If not redirected, <a href="https://desibazaar0.netlify.app/product/${req.params.id}">click here</a>.</p>
                    </div>

                    <script>
                        // Deep Link attempt: Yeh user ko seedha app mein le jayega
                        setTimeout(function() {
                            window.location.href = "https://desibazaar0.netlify.app/product/${req.params.id}";
                        }, 500);
                    </script>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send("Error generating share link");
    }
});

// Product Share API for Meta Tags (WhatsApp Preview)
app.get('/api/product-share/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    
    // Validation
    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Invalid Product</title></head>
        <body>
          <h1>Invalid Product ID</h1>
          <a href="https://desibazaar0.netlify.app">Go to Home</a>
        </body>
        </html>
      `);
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Product Not Found</title></head>
        <body>
          <h1>Product Not Found</h1>
          <a href="https://desibazaar0.netlify.app">Go to Home</a>
        </body>
        </html>
      `);
    }

    // Configuration
    const FRONTEND_URL = process.env.FRONTEND_URL || "https://desibazaar0.netlify.app";
    const ANDROID_PACKAGE = "com.amarjeet.quicksauda";
    
    // Deep Links
    const productWebUrl = `${FRONTEND_URL}/#/product?id=${productId}`;
    const appDeepLink = `quicksauda://product?id=${productId}`;
    
    // Android Intent URL
    const androidIntentUrl = `intent://product/${productId}#Intent;scheme=quicksauda;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`)};end;`;
    
    // Universal Link - Facebook/Instagram के लिए यही काम करेगा
    const universalLink = `https://desibazaar0.netlify.app/#/product?id=${productId}`;
    
    // Alternative Universal Link (query parameters के साथ)
    const universalLinkAlt = `https://desibazaar0.netlify.app/product.html?id=${productId}`;
    
    // Play Store URL
    const PLAY_STORE = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

    const imageUrl = product.images?.[0]?.url ||
                    product.images?.[0] ||
                    `${FRONTEND_URL}/logo.png`;
    
    // ✅ SOCIAL MEDIA DETECTION
    const userAgent = req.headers['user-agent'] || '';
    
    // Facebook और Instagram detection
    const isFacebook = /FBAN|FBAV|Facebook/i.test(userAgent);
    const isInstagram = /Instagram/i.test(userAgent);
    const isSocialMedia = isFacebook || isInstagram || 
                         /Twitter|LinkedIn|Snapchat|Pinterest|Telegram|WhatsApp/i.test(userAgent);
    
    // ✅ FACEBOOK/INSTAGRAM के लिए UNIVERSAL LINK PAGE
    if (isSocialMedia) {
      const socialPlatform = isFacebook ? 'Facebook' : 
                            isInstagram ? 'Instagram' : 
                            'Social Media';
      
      return res.send(`
      <!DOCTYPE html>
      <html lang="en" prefix="og: http://ogp.me/ns#">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        
        <!-- Primary Meta Tags -->
        <title>${product.name} - Quick Sauda</title>
        <meta name="title" content="${product.name}">
        <meta name="description" content="Buy now for ₹${product.price} | Quick Sauda">
        
        <!-- Open Graph / Facebook -->
        <meta property="og:type" content="website">
        <meta property="og:url" content="${universalLink}">
        <meta property="og:title" content="${product.name}">
        <meta property="og:description" content="Price: ₹${product.price} | Order now on Quick Sauda">
        <meta property="og:image" content="${imageUrl}">
        <meta property="og:image:width" content="1200">
        <meta property="og:image:height" content="630">
        <meta property="og:site_name" content="Quick Sauda">
        
        <!-- Twitter -->
        <meta property="twitter:card" content="summary_large_image">
        <meta property="twitter:url" content="${universalLink}">
        <meta property="twitter:title" content="${product.name}">
        <meta property="twitter:description" content="Price: ₹${product.price}">
        <meta property="twitter:image" content="${imageUrl}">
        
        <!-- App Links for Universal Links -->
        <meta property="al:android:url" content="${universalLink}">
        <meta property="al:android:app_name" content="Quick Sauda">
        <meta property="al:android:package" content="${ANDROID_PACKAGE}">
        <meta property="al:ios:url" content="${universalLink}">
        <meta property="al:ios:app_name" content="Quick Sauda">
        <meta property="al:web:should_fallback" content="true">
        <meta property="al:web:url" content="${productWebUrl}">
        
        <!-- iOS Smart App Banner -->
        <meta name="apple-itunes-app" content="app-id=YOUR_IOS_APP_ID, app-argument=${universalLink}">
        
        <!-- Auto-redirect to Universal Link -->
        <meta http-equiv="refresh" content="1; url=${universalLink}" />
        
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            text-align: center;
            padding: 20px;
          }
          
          .container {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 30px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          }
          
          .logo {
            font-size: 2.5rem;
            margin-bottom: 10px;
          }
          
          .app-name {
            font-size: 1.8rem;
            font-weight: bold;
            margin-bottom: 5px;
          }
          
          .tagline {
            opacity: 0.9;
            margin-bottom: 20px;
            font-size: 1rem;
          }
          
          .product-card {
            background: rgba(255, 255, 255, 0.15);
            border-radius: 15px;
            padding: 20px;
            margin: 20px 0;
            text-align: left;
          }
          
          .product-name {
            font-size: 1.3rem;
            margin-bottom: 10px;
            font-weight: bold;
          }
          
          .product-price {
            font-size: 1.8rem;
            color: #fbbf24;
            font-weight: bold;
          }
          
          .loader {
            margin: 20px auto;
            border: 4px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top: 4px solid white;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
          }
          
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          .cta-button {
            display: inline-block;
            margin-top: 20px;
            padding: 15px 30px;
            background: #fbbf24;
            color: #333;
            text-decoration: none;
            border-radius: 12px;
            font-weight: bold;
            font-size: 1.1rem;
            transition: all 0.3s;
          }
          
          .cta-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(0,0,0,0.2);
          }
          
          .fallback-links {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid rgba(255,255,255,0.2);
          }
          
          .fallback-links a {
            display: block;
            margin: 8px 0;
            color: #fbbf24;
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">🛒</div>
          <div class="app-name">Quick Sauda</div>
          <div class="tagline">Instant Grocery Delivery</div>
          
          <div class="loader"></div>
          
          <p style="margin: 15px 0; font-size: 1.1rem;">
            Opening ${product.name} in Quick Sauda...
          </p>
          
          <div class="product-card">
            <div class="product-name">${product.name}</div>
            <div class="product-price">₹${product.price}</div>
            ${product.description ? `
              <div style="margin-top: 10px; opacity: 0.9; font-size: 0.95rem;">
                ${product.description.substring(0, 100)}${product.description.length > 100 ? '...' : ''}
              </div>
            ` : ''}
          </div>
          
          <a href="${universalLink}" class="cta-button" id="openButton">
            Open ${product.name}
          </a>
          
          <div class="fallback-links">
            <p style="font-size: 0.9rem; opacity: 0.8; margin-bottom: 10px;">
              Having trouble? Try these:
            </p>
            <a href="${productWebUrl}">Open in Web Browser</a>
            <a href="${PLAY_STORE}">Download Quick Sauda App</a>
          </div>
        </div>
        
        <script>
          // Platform detection
          const userAgent = navigator.userAgent || navigator.vendor || window.opera;
          const isAndroid = /android/i.test(userAgent);
          const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
          
          // Detect social media in-app browsers
          const isFacebookInApp = /FBAN|FBAV/i.test(userAgent);
          const isInstagramInApp = /Instagram/i.test(userAgent);
          const isSocialMediaInApp = isFacebookInApp || isInstagramInApp;
          
          // Configuration
          const CONFIG = {
            universalLink: "${universalLink}",
            productWebUrl: "${productWebUrl}",
            playStoreUrl: "${PLAY_STORE}",
            appStoreUrl: "https://apps.apple.com/app/idYOUR_IOS_APP_ID"
          };
          
          // Function to open with best method
          function openWithBestMethod() {
            // Social media browsers में सिर्फ Universal Link ही काम करता है
            window.location.href = CONFIG.universalLink;
          }
          
          // Auto-attempt to open
          (function init() {
            // Immediate attempt
            openWithBestMethod();
            
            // Fallback after 1 second
            setTimeout(() => {
              if (document.hasFocus()) {
                // Still on page, show manual button
                document.querySelector('.loader').style.display = 'none';
                document.querySelector('.cta-button').style.display = 'inline-block';
              }
            }, 1000);
            
            // Manual button click
            document.getElementById('openButton').addEventListener('click', function(e) {
              e.preventDefault();
              openWithBestMethod();
            });
            
            // Add click tracking
            document.addEventListener('click', function() {
              // User interacted with page
              console.log('User clicked on page');
            });
            
            // Prevent going back to this page
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, null, window.location.href);
            }
          })();
          
          // Visibility change detection
          document.addEventListener('visibilitychange', function() {
            if (document.hidden) {
              console.log('App may have opened');
            }
          });
        </script>
      </body>
      </html>
      `);
    }

    // ✅ REGULAR BROWSERS के लिए ORIGINAL SMART PAGE
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${product.name} - Quick Sauda</title>
  
  <!-- Open Graph Tags -->
  <meta property="og:title" content="${product.name}">
  <meta property="og:description" content="₹${product.price} - Order now on Quick Sauda">
  <meta property="og:image" content="${imageUrl}">
  <meta property="og:url" content="${productWebUrl}">
  <meta property="og:type" content="product">
  
  <!-- iOS Meta Tags -->
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  
  <!-- App Links -->
  <meta property="al:android:url" content="${appDeepLink}">
  <meta property="al:android:app_name" content="Quick Sauda">
  <meta property="al:android:package" content="${ANDROID_PACKAGE}">
  <meta property="al:web:url" content="${productWebUrl}">
  <meta property="al:ios:url" content="${universalLink}">
  <meta property="al:ios:app_name" content="Quick Sauda">
  
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: white;
    }
    
    .container {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    
    .logo {
      font-size: 2.5rem;
      margin-bottom: 10px;
    }
    
    .app-name {
      font-size: 1.8rem;
      font-weight: bold;
      margin-bottom: 5px;
    }
    
    .tagline {
      opacity: 0.9;
      margin-bottom: 30px;
      font-size: 1.1rem;
    }
    
    .product-card {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 15px;
      padding: 20px;
      margin: 25px 0;
      text-align: left;
    }
    
    .product-name {
      font-size: 1.3rem;
      margin-bottom: 10px;
      font-weight: bold;
    }
    
    .product-price {
      font-size: 1.8rem;
      color: #fbbf24;
      font-weight: bold;
    }
    
    .loading {
      margin: 20px 0;
    }
    
    .spinner {
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top: 4px solid white;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto 15px;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .action-buttons {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 25px;
    }
    
    .btn {
      padding: 16px;
      border-radius: 12px;
      text-decoration: none;
      font-size: 1.1rem;
      font-weight: bold;
      transition: all 0.3s;
      border: none;
      cursor: pointer;
    }
    
    .btn-primary {
      background: white;
      color: #667eea;
    }
    
    .btn-secondary {
      background: rgba(255, 255, 255, 0.2);
      color: white;
      border: 2px solid white;
    }
    
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(0,0,0,0.2);
    }
    
    .fallback-message {
      margin-top: 20px;
      padding: 15px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      display: none;
    }
    
    .manual-link {
      display: inline-block;
      margin-top: 10px;
      padding: 10px 20px;
      background: #fbbf24;
      color: #333;
      border-radius: 8px;
      text-decoration: none;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🛒</div>
    <div class="app-name">Quick Sauda</div>
    <div class="tagline">Instant Grocery Delivery</div>
    
    <div class="product-card">
      <div class="product-name">${product.name}</div>
      <div class="product-price">₹${product.price}</div>
      ${product.description ? `
        <div style="margin-top: 10px; opacity: 0.9; font-size: 0.95rem;">
          ${product.description.substring(0, 120)}${product.description.length > 120 ? '...' : ''}
        </div>
      ` : ''}
    </div>
    
    <div class="loading" id="loading">
      <div class="spinner"></div>
      <div id="statusText">Opening in Quick Sauda app...</div>
    </div>
    
    <div class="action-buttons" id="actionButtons" style="display: none;">
      <button onclick="openInApp()" class="btn btn-primary" id="openAppBtn">
        Open in Quick Sauda App
      </button>
      <a href="${productWebUrl}" class="btn btn-secondary">
        View on Website
      </a>
      <button onclick="downloadApp()" class="btn btn-secondary">
        Download App
      </button>
    </div>
    
    <div class="fallback-message" id="fallbackMessage">
      <p>If the app doesn't open automatically:</p>
      <a href="${universalLink}" class="manual-link" id="manualLink">
        Tap to Open Product (Universal Link)
      </a>
      <br>
      <a href="${appDeepLink}" class="manual-link" style="background: #667eea; margin-top: 8px;">
        Tap to Open Product (Deep Link)
      </a>
    </div>
  </div>

  <script>
    // Platform detection
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const isAndroid = /android/i.test(userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
    
    // Detect social media in-app browsers
    const isFacebookInApp = /FBAN|FBAV/i.test(userAgent);
    const isInstagramInApp = /Instagram/i.test(userAgent);
    const isSocialMediaInApp = isFacebookInApp || isInstagramInApp;
    
    // Configuration
    const CONFIG = {
      appDeepLink: "${appDeepLink}",
      androidIntentUrl: "${androidIntentUrl}",
      universalLink: "${universalLink}",
      productWebUrl: "${productWebUrl}",
      playStoreUrl: "${PLAY_STORE}",
      timeout: 2000,
      checkInterval: 100
    };
    
    // State
    let appOpened = false;
    let startTime = Date.now();
    
    // Function to check if app opened successfully
    function checkIfAppOpened() {
      if (document.hidden || !document.hasFocus()) {
        appOpened = true;
        return true;
      }
      
      if (Date.now() - startTime > CONFIG.timeout) {
        return false;
      }
      
      return null;
    }
    
    // Function to open app with the BEST method for each platform
    function openAppWithBestMethod() {
      // Social media browsers में Universal Link use करें
      if (isSocialMediaInApp) {
        window.location.href = CONFIG.universalLink;
        return;
      }
      
      if (isAndroid) {
        window.location.href = CONFIG.androidIntentUrl;
      } else if (isIOS) {
        if (CONFIG.universalLink && CONFIG.universalLink !== '') {
          window.location.href = CONFIG.universalLink;
        }
        setTimeout(() => {
          if (!appOpened) {
            window.location.href = CONFIG.appDeepLink;
          }
        }, 300);
      } else {
        window.location.href = CONFIG.productWebUrl;
        appOpened = true;
      }
    }
    
    // Function to show fallback options
    function showFallbackOptions() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('statusText').textContent = 'Choose an option:';
      document.getElementById('actionButtons').style.display = 'flex';
      document.getElementById('fallbackMessage').style.display = 'block';
    }
    
    // Function to manually open app
    function openInApp() {
      document.getElementById('statusText').textContent = 'Trying to open app...';
      document.getElementById('loading').style.display = 'block';
      document.getElementById('actionButtons').style.display = 'none';
      
      startTime = Date.now();
      appOpened = false;
      
      openAppWithBestMethod();
      
      setTimeout(() => {
        if (!checkIfAppOpened()) {
          showFallbackOptions();
        }
      }, CONFIG.timeout);
    }
    
    // Function to download app
    function downloadApp() {
      window.location.href = CONFIG.playStoreUrl;
    }
    
    // MAIN EXECUTION
    (function init() {
      // Social media में Instant Universal Link redirect
      if (isSocialMediaInApp) {
        document.getElementById('statusText').textContent = 'Opening via Universal Link...';
        setTimeout(() => {
          window.location.href = CONFIG.universalLink;
        }, 100);
        return;
      }
      
      openAppWithBestMethod();
      
      const checkInterval = setInterval(() => {
        const status = checkIfAppOpened();
        
        if (status === true) {
          clearInterval(checkInterval);
          console.log('App opened successfully!');
        } else if (status === false) {
          clearInterval(checkInterval);
          showFallbackOptions();
          console.log('Showing fallback options');
        }
      }, CONFIG.checkInterval);
      
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!appOpened) {
          showFallbackOptions();
        }
      }, CONFIG.timeout + 1000);
      
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          appOpened = true;
        }
      });
      
      window.addEventListener('blur', () => {
        appOpened = true;
      });
      
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, null, window.location.href);
      }
    })();
    
    document.getElementById('manualLink').addEventListener('click', function(e) {
      e.preventDefault();
      window.location.href = CONFIG.universalLink;
      
      document.getElementById('actionButtons').style.display = 'none';
      document.getElementById('fallbackMessage').style.display = 'none';
      document.getElementById('loading').style.display = 'block';
      document.getElementById('statusText').textContent = 'Opening app...';
    });
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(html);

  } catch (error) {
    console.error('Product share error:', error);
    
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error - Quick Sauda</title>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .error-box {
            background: rgba(255,255,255,0.1);
            padding: 40px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
            max-width: 500px;
          }
          h1 { margin-bottom: 20px; }
          a {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 30px;
            background: white;
            color: #667eea;
            text-decoration: none;
            border-radius: 10px;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="error-box">
          <h1>⚠️ Something went wrong</h1>
          <p>We're unable to load this product right now.</p>
          <a href="https://desibazaar0.netlify.app">Go to Homepage</a>
        </div>
      </body>
      </html>
    `);
  }
});


// ✅ विशेष रूप से Flutter ऐप के लिए JSON डेटा भेजने वाला रूट
app.get('/api/product-share/json/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. ID validation
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ 
                message: "Invalid product ID format" 
            });
        }

        const product = await Product.findById(id);
        
        if (!product) {
            return res.status(404).json({ 
                message: "Product not found",
                id: id
            });
        }

        // 2. Image URL extraction with better handling
        const getImageUrl = (images) => {
            if (!images || !Array.isArray(images) || images.length === 0) {
                return 'https://desibazaar0.netlify.app/logo.png';
            }
            
            const firstImage = images[0];
            if (typeof firstImage === 'object' && firstImage.url) {
                return firstImage.url;
            } else if (typeof firstImage === 'string') {
                return firstImage;
            }
            
            return 'https://desibazaar0.netlify.app/logo.png';
        };

        // 3. Default domain URL (environment variable से लेने के लिए)
        const DOMAIN_URL = process.env.DOMAIN_URL || 'https://hdvideo-1.onrender.com';
        
        // 4. Response data structure
        const responseData = {
            success: true,
            data: {
                id: product._id,
                name: product.name,
                price: product.price,
                currency: product.currency || '₹', // Default currency
                image: getImageUrl(product.images),
                url: `${DOMAIN_URL}/api/product-share/${product._id}`,
                // Additional useful fields for social media
                description: product.description || product.name,
                category: product.category,
                brand: product.brand
            },
            timestamp: new Date().toISOString()
        };

        // 5. Cache control headers for CDN/API caching
        res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour cache
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        
        res.json(responseData);

    } catch (err) {
        console.error(`Error fetching product ${req.params.id}:`, err);
        
        // 6. Better error handling
        const statusCode = err.name === 'CastError' ? 400 : 500;
        
        res.status(statusCode).json({
            success: false,
            message: "Error fetching product data",
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});


const IP = '0.0.0.0';
const PORT = process.env.PORT || 5001;

app.listen(PORT, IP, () => {
  console.log(`🚀 Server running on http://${IP}:${PORT}`);
});
