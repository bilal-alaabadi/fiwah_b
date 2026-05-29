const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    mainCategory: {
      type: String,
      required: true,
      enum: ["الزيوت العطرية", "المياه العطرية", "منتجات العناية الشخصية"],
    },

    category: { type: String, required: true },

    description: { type: String, required: true },

    price: { type: Number, required: true, min: 0 },

    image: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "يجب إرسال صورة واحدة على الأقل",
      },
    },

    oldPrice: { type: Number, min: 0 },

    rating: { type: Number, default: 0, min: 0, max: 5 },

    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    inStock: { type: Boolean, default: true },

    size: { type: String, required: true },

    stock: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

const Products = mongoose.model("Product", ProductSchema);

module.exports = Products;