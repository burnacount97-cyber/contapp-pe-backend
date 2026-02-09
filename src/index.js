import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { firebaseAdmin, firestore } from "./firebase.js";
import { getPaypalBaseUrl, getPaypalToken, verifyPaypalWebhook } from "./paypal.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;
const actionTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const parseOrigins = () => {
  const raw = process.env.CORS_ORIGIN || "";
  const list = raw.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length ? list : true;
};

app.use(cors({ origin: parseOrigins() }));
app.use(express.json({ limit: "1mb" }));

const requireAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing auth token" });
  }

  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(token);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

const planFromId = (planId) => {
  if (!planId) return null;
  if (planId === process.env.PAYPAL_PLAN_ID_PRO) return "PRO";
  if (planId === process.env.PAYPAL_PLAN_ID_PLUS) return "PLUS";
  return null;
};

const getPlanId = (planCode) => {
  if (planCode === "PRO") return process.env.PAYPAL_PLAN_ID_PRO;
  if (planCode === "PLUS") return process.env.PAYPAL_PLAN_ID_PLUS;
  return null;
};

const getBaseUrl = (req) => {
  return process.env.APP_BASE_URL || req.headers.origin || `https://${req.headers.host}`;
};

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/chat", requireAuth, async (req, res) => {
  const { messages, model } = req.body || {};
  const key = process.env.OPENAI_API_KEY;

  if (!key) {
    return res.status(400).json({ error: "Missing OPENAI_API_KEY" });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Missing messages" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        messages,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(actionTimeout),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "OpenAI error",
      });
    }

    const reply = data?.choices?.[0]?.message?.content || "";
    return res.status(200).json({ reply: reply.trim() });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Server error" });
  }
});

app.post("/paypal/create-subscription", requireAuth, async (req, res) => {
  try {
    const { planCode } = req.body || {};
    const planId = getPlanId(planCode);
    if (!planCode || !planId) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const baseUrl = getBaseUrl(req);
    const returnUrl = `${baseUrl}/dashboard/plan?paypal=success`;
    const cancelUrl = `${baseUrl}/dashboard/plan?paypal=cancel`;

    const accessToken = await getPaypalToken();
    const response = await fetch(`${getPaypalBaseUrl()}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        plan_id: planId,
        custom_id: `${req.user.uid}:${planCode}`,
        application_context: {
          brand_name: "ContApp Peru",
          locale: "es-PE",
          user_action: "SUBSCRIBE_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.message || "PayPal error" });
    }

    const approval = data?.links?.find((link) => link.rel === "approve");
    if (!approval?.href) {
      return res.status(500).json({ error: "No approval link" });
    }

    const userRef = firestore.collection("users").doc(req.user.uid);
    await userRef.set(
      {
        paypalSubscriptionId: data.id,
        paypalPlanId: planId,
        pendingPlan: planCode,
        updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ approvalUrl: approval.href, subscriptionId: data.id });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Server error" });
  }
});

app.post("/paypal/webhook", async (req, res) => {
  try {
    const event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const ok = await verifyPaypalWebhook(req.headers, event);
    if (!ok) {
      return res.status(400).json({ error: "Webhook not verified" });
    }

    const type = event?.event_type || "";
    const resource = event?.resource || {};
    const subscriptionId = resource?.id;
    const planId = resource?.plan_id;
    const planCode = planFromId(planId);
    const customId = resource?.custom_id || "";
    const [customUid, customPlan] = customId.split(":");
    const uid = customUid || customId || null;

    let userRef = null;
    if (uid) {
      userRef = firestore.collection("users").doc(uid);
    } else if (subscriptionId) {
      const snap = await firestore
        .collection("users")
        .where("paypalSubscriptionId", "==", subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        userRef = snap.docs[0].ref;
      }
    }

    if (!userRef) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const updates = {
      paypalSubscriptionId: subscriptionId || null,
      paypalPlanId: planId || null,
      updatedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
    };

    if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      updates.status = "ACTIVE";
      updates.plan = planCode || customPlan || "PRO";
      updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
    }

    if (
      type === "BILLING.SUBSCRIPTION.CANCELLED" ||
      type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
      type === "BILLING.SUBSCRIPTION.EXPIRED" ||
      type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
    ) {
      updates.status = "SUSPENDED";
      updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
    }

    if (type === "BILLING.SUBSCRIPTION.UPDATED") {
      if (resource?.status === "ACTIVE") {
        updates.status = "ACTIVE";
        updates.plan = planCode || customPlan || "PRO";
        updates.pendingPlan = firebaseAdmin.firestore.FieldValue.delete();
      }
    }

    await userRef.set(updates, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error?.message || "Webhook error" });
  }
});

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
