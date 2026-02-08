const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* =====================================================
   1️⃣ AUTO-UPDATE STATS: ON PAYOUT REQUEST CREATED
===================================================== */
exports.onPayoutRequested = functions.firestore
  .document("payoutRequests/{id}")
  .onCreate(async (snap) => {
    const data = snap.data();
    const statsRef = db.collection("adminStats").doc("global");

    return statsRef.set({
      pendingPayoutsCount: FieldValue.increment(1),
      totalPendingAmount: FieldValue.increment(data.amount || 0),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });
  });

/* =====================================================
   2️⃣ AUTO-UPDATE STATS: ON USER QUERY CREATED
===================================================== */
exports.onQueryCreated = functions.firestore
  .document("queries/{id}")
  .onCreate(async () => {
    const statsRef = db.collection("adminStats").doc("global");

    return statsRef.set({
      openQueriesCount: FieldValue.increment(1),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });
  });

/* =====================================================
   3️⃣ REWARD SYSTEM (CORE MONEY LOGIC)
===================================================== */
exports.rewarduser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const uid = context.auth.uid;

  // 💰 SAFE & PROFITABLE RATES
  const GROSS_REVENUE_PER_VIEW = 15.50;
  const REWARD_AMOUNT = 0.50;
  const ADMIN_REVENUE = GROSS_REVENUE_PER_VIEW - REWARD_AMOUNT;

  const COOLDOWN_SECONDS = 30;
  const DAILY_LIMIT = 50.00;

  const userRef = db.collection("users").doc(uid);
  const statsRef = db.collection("adminStats").doc("global");

  return db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new functions.https.HttpsError("not-found", "User document missing");
    }

    const user = userSnap.data();
    const now = admin.firestore.Timestamp.now();
    const todayStr = new Date().toISOString().split("T")[0];

    // 🚫 BANNED CHECK
    if (user.status === "banned") {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Account suspended"
      );
    }

    // ⏱️ COOLDOWN CHECK
    if (user.lastEarnedAt) {
      const secondsPassed =
        (now.toMillis() - user.lastEarnedAt.toMillis()) / 1000;

      if (secondsPassed < COOLDOWN_SECONDS) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `Wait ${Math.ceil(COOLDOWN_SECONDS - secondsPassed)} seconds`
        );
      }
    }

    // 📆 DAILY LIMIT CHECK
    const dailyTotal =
      user.lastEarnedDate === todayStr ? (user.dailyTotal || 0) : 0;

    if (dailyTotal + REWARD_AMOUNT > DAILY_LIMIT) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Daily limit reached"
      );
    }

    // 💳 UPDATE USER BALANCE
    tx.update(userRef, {
      balance: FieldValue.increment(REWARD_AMOUNT),
      totalEarned: FieldValue.increment(REWARD_AMOUNT),
      dailyTotal: dailyTotal + REWARD_AMOUNT,
      lastEarnedDate: todayStr,
      lastEarnedAt: now
    });

    // 📊 UPDATE GLOBAL STATS
    tx.set(statsRef, {
      totalEarningsByUsers: FieldValue.increment(REWARD_AMOUNT),
      adminRevenue: FieldValue.increment(ADMIN_REVENUE),
      lastUpdated: now
    }, { merge: true });

    // 🧾 LOG EARNING
    const earningRef = userRef.collection("earnings").doc();
    tx.set(earningRef, {
      amount: REWARD_AMOUNT,
      videoId: data.videoId || "unknown",
      timestamp: now
    });

    return {
  success: true,
  reward: REWARD_AMOUNT,
  adminRevenue: ADMIN_REVENUE,
  newBalance: (user.balance || 0) + REWARD_AMOUNT
};

  });
});

/* =====================================================
   4️⃣ ADMIN: APPROVE PAYOUT (SECURE)
===================================================== */
exports.approvePayout = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Login required");
  }

  const adminSnap = await db
    .collection("users")
    .doc(context.auth.uid)
    .get();

  if (adminSnap.data()?.role !== "admin") {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Admin access required"
    );
  }

  const payoutId = data.payoutId;
  if (!payoutId) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "payoutId required"
    );
  }

  const payoutRef = db.collection("payoutRequests").doc(payoutId);

  return db.runTransaction(async (tx) => {
    const payoutSnap = await tx.get(payoutRef);
    if (!payoutSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Payout not found");
    }

    const payout = payoutSnap.data();
    if (payout.status !== "pending") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Already processed"
      );
    }

    const userRef = db.collection("users").doc(payout.uid);
    const userSnap = await tx.get(userRef);

    if ((userSnap.data().balance || 0) < payout.amount) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Insufficient balance"
      );
    }

    const statsRef = db.collection("adminStats").doc("global");

    // ✅ MARK PAYOUT AS APPROVED
    tx.update(payoutRef, {
      status: "approved",
      approvedAt: FieldValue.serverTimestamp()
    });

    // 💸 DEDUCT USER BALANCE
    tx.update(userRef, {
      balance: FieldValue.increment(-payout.amount),
      hasPendingPayout: false
    });

    // 📊 UPDATE STATS
    tx.set(statsRef, {
      pendingPayoutsCount: FieldValue.increment(-1),
      totalPendingAmount: FieldValue.increment(-payout.amount),
      totalPaidOut: FieldValue.increment(payout.amount),
      lastUpdated: FieldValue.serverTimestamp()
    }, { merge: true });

    return {
      success: true,
      message: `R${payout.amount} paid to ${payout.email}`
    };
  });
});
