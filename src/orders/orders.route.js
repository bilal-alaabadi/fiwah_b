// ========================= routes/orders.js (نهائي - شحن خليجي بالكتل + idempotency + تنزيل مخزون) =========================
const express = require("express");
const cors = require("cors");
const Order = require("./orders.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();
const axios = require("axios");
require("dotenv").config();

// ✅ استيراد موديل المنتجات لتنزيل المخزون
const Product = require("../products/products.model");

const THAWANI_API_KEY = process.env.THAWANI_API_KEY; 
const THAWANI_API_URL = process.env.THAWANI_API_URL;
const THAWANI_PUBLISH_KEY = process.env.THAWANI_PUBLISH_KEY;

const app = express();
app.use(cors({ origin: "https://www.fawahaljabal.com" }));
app.use(express.json());

// ========================= create-checkout-session =========================
const ORDER_CACHE = new Map(); // key: client_reference_id -> value: orderPayload
const toBaisa = (omr) => Math.max(100, Math.round(Number(omr || 0) * 1000)); // >= 100 بيسة

const pairDiscountForProduct = (p) => {
  const isShayla = p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
  if (!isShayla) return 0;
  const qty = Number(p.quantity || 0);
  const pairs = Math.floor(qty / 2);
  return pairs * 1; // 1 ر.ع لكل زوج
};

const hasGiftValues = (gc) => {
  if (!gc || typeof gc !== "object") return false;
  const v = (x) => (x ?? "").toString().trim();
  return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
};

const normalizeGift = (gc) =>
  hasGiftValues(gc)
    ? { from: gc.from || "", to: gc.to || "", phone: gc.phone || "", note: gc.note || "" }
    : undefined;

// ✅ حساب الشحن (ريال عُماني) للدول الخليجية حسب الكتل
// أول 3 منتجات على الأساس فقط (لا زيادة)، ومن المنتج الرابع تبدأ الزيادة:
// 4–6 => +4 ر.ع، 7–9 => +8 ر.ع، وهكذا.
const computeGulfShipping = (gulfCountry, totalItems) => {
  const base = gulfCountry === "الإمارات" ? 4 : 5;
  const n = Math.max(0, Number(totalItems) || 0);
  if (n <= 3) return base;
  const extraItems = n - 3;
  const blocks = Math.ceil(extraItems / 3); // 👈 يبدأ من القطعة الرابعة
  return base + blocks * 4;
};

router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
    depositMode, // إذا true: المقدم 10 ر.ع (من ضمنه التوصيل)
    giftCard,    // { from, to, phone, note } اختياري (على مستوى الطلب)
    gulfCountry, // الدولة المختارة داخل "دول الخليج" (إن وُجدت)
  } = req.body;

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  // إجمالي عدد القطع
  const totalItems = products.reduce((sum, p) => sum + Number(p.quantity || 0), 0);

  // رسوم الشحن (ر.ع.) وفق السياسة الجديدة لدول الخليج
  const shippingFee =
    country === "دول الخليج"
      ? computeGulfShipping(gulfCountry, totalItems)
      : 2;

  const DEPOSIT_AMOUNT_OMR = 10;

  try {
    const productsSubtotal = products.reduce(
      (sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 0),
      0
    );
    const totalPairDiscount = products.reduce(
      (sum, p) => sum + pairDiscountForProduct(p),
      0
    );
    const subtotalAfterDiscount = Math.max(0, productsSubtotal - totalPairDiscount);
    const originalTotal = subtotalAfterDiscount + shippingFee;

    let lineItems = [];
    let amountToCharge = 0;

    if (depositMode) {
      lineItems = [
        { name: "دفعة مقدم", quantity: 1, unit_amount: toBaisa(DEPOSIT_AMOUNT_OMR) },
      ];
      amountToCharge = DEPOSIT_AMOUNT_OMR;
    } else {
      lineItems = products.map((p) => {
        const unitBase = Number(p.price || 0);
        const qty = Math.max(1, Number(p.quantity || 1));
        const productDiscount = pairDiscountForProduct(p);
        const unitAfterDiscount = Math.max(0.1, unitBase - productDiscount / qty);
        return {
          name: String(p.name || "منتج"),
          quantity: qty,
          unit_amount: toBaisa(unitAfterDiscount),
        };
      });

      // بند الشحن النهائي (يشمل كتل 3/3)
      lineItems.push({
        name: "رسوم الشحن",
        quantity: 1,
        unit_amount: toBaisa(shippingFee),
      });

      amountToCharge = originalTotal;
    }

    const nowId = Date.now().toString();

    const orderPayload = {
      orderId: nowId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: p.quantity,
        name: p.name,
        price: p.price,
        image: Array.isArray(p.image) ? p.image[0] : p.image,
        measurements: p.measurements || {},
        category: p.category || "",
        giftCard: normalizeGift(p.giftCard) || undefined,
      })),
      amountToCharge,
      shippingFee,      // النهائي
      customerName,
      customerPhone,
      country,
      gulfCountry: gulfCountry || "", // حفظها للكاش
      wilayat,
      description,
      email: email || "",
      status: "completed",
      depositMode: !!depositMode,
      remainingAmount: depositMode ? Math.max(0, originalTotal - DEPOSIT_AMOUNT_OMR) : 0,
      giftCard: normalizeGift(giftCard),
    };

    ORDER_CACHE.set(nowId, orderPayload);

    const data = {
      client_reference_id: nowId,
      mode: "payment",
      products: lineItems,
      success_url: "https://www.fawahaljabal.com/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "https://www.fawahaljabal.com/cancel",
      metadata: {
        email: String(email || "غير محدد"),
        customer_name: String(customerName || ""),
        customer_phone: String(customerPhone || ""),
        country: String(country || ""),
        gulfCountry: String(gulfCountry || ""), // لاحتساب احتياطي لاحقًا
        wilayat: String(wilayat || ""),
        description: String(description || "لا يوجد وصف"),
        shippingFee: String(shippingFee), // الشحن النهائي
        internal_order_id: String(nowId),
        source: "mern-backend",
      },
    };

    const response = await axios.post(`${THAWANI_API_URL}/checkout/session`, data, {
      headers: {
        "Content-Type": "application/json",
        "thawani-api-key": THAWANI_API_KEY,
      },
    });

    const sessionId = response?.data?.data?.session_id;
    if (!sessionId) {
      ORDER_CACHE.delete(nowId);
      return res.status(500).json({
        error: "No session_id returned from Thawani",
        details: response?.data,
      });
    }

    const paymentLink = `https://checkout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISH_KEY}`;
    res.json({ id: sessionId, paymentLink });
  } catch (error) {
    console.error("Error creating checkout session:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to create checkout session",
      details: error?.response?.data || error.message,
    });
  }
});

// ========================= order-with-products (بدون تغيير منطقي) =========================
router.get('/order-with-products/:orderId', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const products = await Promise.all(order.products.map(async item => {
      const product = await Product.findById(item.productId);
      return {
        ...product.toObject(),
        quantity: item.quantity,
        selectedSize: item.selectedSize,
        price: calculateProductPrice(product, item.quantity, item.selectedSize)
      };
    }));

    res.json({ order, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calculateProductPrice(product, quantity, selectedSize) {
  if (product.category === 'حناء بودر' && selectedSize && product.price[selectedSize]) {
    return (product.price[selectedSize] * quantity).toFixed(2);
  }
  return (product.regularPrice * quantity).toFixed(2);
}

// ========================= confirm-payment (نهائي - idempotency + تنزيل مخزون + شحن خليجي احتياطي) =========================
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  const hasGiftValuesLocal = (gc) => {
    if (!gc || typeof gc !== "object") return false;
    const v = (x) => (x ?? "").toString().trim();
    return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
  };
  const normalizeGiftLocal = (gc) =>
    hasGiftValuesLocal(gc)
      ? { from: gc.from || "", to: gc.to || "", phone: gc.phone || "", note: gc.note || "" }
      : undefined;

  try {
    // 1) ابحث عن الجلسة في ثواني
    const sessionsResponse = await axios.get(
      `${THAWANI_API_URL}/checkout/session/?limit=20&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const sessions = sessionsResponse?.data?.data || [];
    const sessionSummary = sessions.find(
      (s) => s.client_reference_id === client_reference_id
    );
    if (!sessionSummary) {
      return res.status(404).json({ error: "Session not found" });
    }
    const session_id = sessionSummary.session_id;

    // 2) تأكد من حالة الدفع
    const response = await axios.get(
      `${THAWANI_API_URL}/checkout/session/${session_id}?limit=1&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const session = response?.data?.data;
    if (!session || session.payment_status !== "paid") {
      return res.status(400).json({ error: "Payment not successful or session not found" });
    }

    // 3) ميتاداتا خفيفة
    const meta = session?.metadata || session?.meta_data || {};
    const metaCustomerName = meta.customer_name || "";
    const  metaCustomerPhone = meta.customer_phone || "";
    const metaEmail = meta.email || "";
    const metaCountry = meta.country || "";
    const metaGulfCountry = meta.gulfCountry || meta.gulf_country || "";
    const metaWilayat = meta.wilayat || "";
    const metaDescription = meta.description || "";
    const metaShippingFee =
      typeof meta.shippingFee !== "undefined" ? Number(meta.shippingFee) : undefined;

    // 4) احضر/كوّن الطلب
    let order = await Order.findOne({ orderId: client_reference_id });

    const paidAmountOMR = Number(session.total_amount || 0) / 1000;
    const cached = ORDER_CACHE.get(client_reference_id) || {};

    const productsFromCache = Array.isArray(cached.products)
      ? cached.products.map((p) => ({
          productId: p.productId || p._id,
          quantity: p.quantity,
          name: p.name,
          price: p.price,
          image: Array.isArray(p.image) ? p.image[0] : p.image,
          category: p.category || "",
          measurements: p.measurements || {},
          giftCard: normalizeGiftLocal(p.giftCard),
        }))
      : [];

    // ✅ احتساب احتياطي لرسوم الشحن لو لم تصل من meta (نفس منطق الإنشاء)
    const resolvedShippingFee = (() => {
      if (typeof metaShippingFee !== "undefined") return metaShippingFee;
      if (typeof cached.shippingFee !== "undefined") return Number(cached.shippingFee);
      const country = (cached.country || metaCountry || "").trim();
      const gulf = (cached.gulfCountry || metaGulfCountry || "").trim();
      if (country === "دول الخليج") {
        const totalItems = Array.isArray(productsFromCache)
          ? productsFromCache.reduce((sum, it) => sum + Number(it.quantity || 0), 0)
          : 0;
        return computeGulfShipping(gulf, totalItems); // 👈 نفس الدالة (تزيد من الرابع)
      }
      return 2;
    })();

    if (!order) {
      const orderLevelGift = normalizeGiftLocal(cached.giftCard);
      order = new Order({
        orderId: cached.orderId || client_reference_id,
        products: productsFromCache,
        amount: paidAmountOMR,
        shippingFee: resolvedShippingFee,
        customerName: cached.customerName || metaCustomerName,
        customerPhone: cached.customerPhone || metaCustomerPhone,
        country: cached.country || metaCountry,
        wilayat: cached.wilayat || metaWilayat,
        description: cached.description || metaDescription,
        email: cached.email || metaEmail,
        status: "completed",
        depositMode: !!cached.depositMode,
        remainingAmount: Number(cached.remainingAmount || 0),
        giftCard: orderLevelGift,
      });
    } else {
      order.status = "completed";
      order.amount = paidAmountOMR;

      if (!order.customerName && metaCustomerName) order.customerName = metaCustomerName;
      if (!order.customerPhone && metaCustomerPhone) order.customerPhone = metaCustomerPhone;
      if (!order.country && metaCountry) order.country = metaCountry;
      if (!order.wilayat && metaWilayat) order.wilayat = metaWilayat;
      if (!order.description && metaDescription) order.description = metaDescription;
      if (!order.email && metaEmail) order.email = metaEmail;

      if (order.shippingFee === undefined || order.shippingFee === null) {
        order.shippingFee = resolvedShippingFee;
      }

      if (productsFromCache.length > 0) {
        order.products = productsFromCache;
      }

      if (!hasGiftValuesLocal(order.giftCard) && hasGiftValuesLocal(cached.giftCard)) {
        order.giftCard = normalizeGiftLocal(cached.giftCard);
      }
    }

    // ====== Idempotency قبل تعديل المخزون ======
    const alreadyProcessed =
      order.paymentSessionId === session_id &&
      order.status === "completed" &&
      !!order.paidAt;

    order.paymentSessionId = session_id;
    order.paidAt = new Date();

    await order.save();

    // تنزيل المخزون مرة واحدة فقط
    if (!alreadyProcessed) {
      try {
        if (Array.isArray(order.products) && order.products.length > 0) {
          await Promise.all(
            order.products.map((item) => {
              const qty = Number(item.quantity || 0);
              if (!item.productId || !Number.isFinite(qty) || qty <= 0) {
                return Promise.resolve();
              }
              return Product.updateOne(
                { _id: item.productId },
                [
                  {
                    $set: {
                      stock: { $max: [0, { $subtract: ["$stock", qty] }] },
                      inStock: { $gt: [{ $subtract: ["$stock", qty] }, 0] }
                    }
                  }
                ]
              ).exec();
            })
          );
        }
      } catch (decErr) {
        console.error("Stock decrement failed:", decErr);
      }
    }

    ORDER_CACHE.delete(client_reference_id);

    res.json({ order, alreadyProcessed });
  } catch (error) {
    console.error("Error confirming payment:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to confirm payment",
      details: error?.response?.data || error.message,
    });
  }
});

// ========================= باقي المسارات (بدون تغيير) =========================
router.get("/:email", async (req, res) => {
  const email = req.params.email;

  if (!email) {
    return res.status(400).send({ message: "Email is required" });
  }

  try {
    const orders = await Order.find({ email: email });

    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found for this email" });
    }

    res.status(200).send({ orders });
  } catch (error) {
    console.error("Error fetching orders by email:", error);
    res.status(500).send({ message: "Failed to fetch orders by email" });
  }
});

router.get("/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }
    res.status(200).send(order);
  } catch (error) {
    console.error("Error fetching orders by user id", error);
    res.status(500).send({ message: "Failed to fetch orders by user id" });
  }
});

router.get("/", async (req, res) => {
  try {
    const orders = await Order.find({status:"completed"}).sort({ createdAt: -1 });
    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found", orders: [] });
    }

    res.status(200).send(orders);
  } catch (error) {
    console.error("Error fetching all orders", error);
    res.status(500).send({ message: "Failed to fetch all orders" });
  }
});

router.patch("/update-order-status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) {
    return res.status(400).send({ message: "Status is required" });
  }

  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      {
        status,
        updatedAt: new Date(),
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).json({
      message: "Order status updated successfully",
      order: updatedOrder
    });

  } catch (error) {
    console.error("Error updating order status", error);
    res.status(500).send({ message: "Failed to update order status" });
  }
});

router.delete('/delete-order/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const deletedOrder = await Order.findByIdAndDelete(id);
    if (!deletedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }
    res.status(200).json({
      message: "Order deleted successfully",
      order: deletedOrder
    });

  } catch (error) {
    console.error("Error deleting order", error);
    res.status(500).send({ message: "Failed to delete order" });
  }
});

module.exports = router;
