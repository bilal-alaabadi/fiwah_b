// ========================= models/Order.js =========================
const mongoose = require("mongoose");

const GiftCardSchema = new mongoose.Schema(
  {
    from: { type: String, default: "" },
    to: { type: String, default: "" },
    phone: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true },

    products: [
      {
        productId: { type: String, required: true },
        quantity: { type: Number, required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        image: { type: String },
        category: { type: String },
        size: { type: String, default: "" },

        measurements: {
          length: { type: String },
          sleeveLength: { type: String },
          width: { type: String },
          design: { type: String },
          color: { type: String },
          buttons: { type: String },
        },

        giftCard: { type: GiftCardSchema, default: undefined },
      },
    ],

    amount: { type: Number, required: true },
    shippingFee: { type: Number, required: true, default: 2 },

    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    country: { type: String, required: true },
    gulfCountry: { type: String, default: "" },
    wilayat: { type: String, required: true },
    description: { type: String },

    email: { type: String, default: "" },

    status: {
      type: String,
      required: true,
      enum: ["failed", "completed", "pending"],
      default: "pending",
    },

    currency: {
      type: String,
      required: true,
      enum: ["OMR", "AED"],
      default: "OMR",
    },

    paymentSessionId: { type: String },
    paidAt: { type: Date },

    depositMode: { type: Boolean, default: false },
    remainingAmount: { type: Number, default: 0 },

    giftCard: { type: GiftCardSchema, default: undefined },
  },
  { timestamps: true }
);

const Order = mongoose.model("Order", OrderSchema);

module.exports = Order;