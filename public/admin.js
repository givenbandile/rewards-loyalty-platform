// ===============================
// 🔥 1. INITIALIZE & SECURITY (LAPTOP FRIENDLY)
// ===============================
if (!firebase.apps.length) {
    firebase.initializeApp({
        apiKey: "AIzaSyDBYzvleKKLKvKtkEuu8utwZHJnc70lh3E",
        authDomain: "videorewardsweb.firebaseapp.com",
        projectId: "videorewardsweb",
        storageBucket: "videorewardsweb.firebasestorage.app",
        messagingSenderId: "844494435984",
        appId: "1:844494435984:web:3011f3871a3eeefc95ca15"
    });
}

const db = firebase.firestore();
const auth = firebase.auth();
const functions = firebase.app().functions("us-central1");

// ===============================
// 🔐 FIREBASE APP CHECK (ONCE)
// ===============================
let appCheckInstance;

if (!appCheckInstance) {
  // Debug token ONLY for localhost
  if (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1"
  ) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    console.log("🛠️ App Check Debug Mode");
  }

  appCheckInstance = firebase.appCheck();
  appCheckInstance.activate(
    new firebase.appCheck.ReCaptchaV3Provider(
      "6LeZI1EsAAAAAOhgs3Dru3eoYQcsJjRWQhkqjB39"
    ),
    true
  );
}


// ===============================
// 🚀 2. AUTH + ADMIN GUARD
// ===============================

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  try {
    // Check your specific email instead of the hidden claim for now
    const adminEmail = "givenbandile31@gmail.com"; // <--- Put your email here
    
    if (user.email !== adminEmail) {
       throw new Error("You are not the authorized Admin email.");
    }

    console.log("✅ Admin Verified via Email Check");

    initRealTimeStats();
    initPayoutListener();
    initQueryListener();

  } catch (err) {
    console.error("❌ AUTH ERROR:", err.message);
    alert("Access Denied: " + err.message);
    await auth.signOut();
    window.location.href = "index.html";
  }
});


// ===============================
// 📊 3. REAL-TIME ADMIN STATS
// ===============================
function initRealTimeStats() {
  db.collection("adminStats").doc("global").onSnapshot((doc) => {
    if (!doc.exists) return;
    const s = doc.data();
    
    const adminRev = s.adminRevenue || 0; 
    const userOwed = s.totalEarningsByUsers || 0;

    db.collection("payoutRequests")
      .where("status", "==", "pending")
      .onSnapshot(snap => {
        let pendingTotal = 0;
        snap.forEach(d => pendingTotal += d.data().amount || 0);

        document.getElementById("totalUsers").innerText = s.totalUsers || 0;
        document.getElementById("totalEarningsByUsers").innerText = userOwed.toFixed(2);
        document.getElementById("adminRevenue").innerText = adminRev.toFixed(2);
        document.getElementById("pendingPayouts").innerText = pendingTotal.toFixed(2);

        const safeBalance = adminRev - (userOwed + pendingTotal);
        
        if(document.getElementById("displayAdminRev")) {
            document.getElementById("displayAdminRev").innerText = adminRev.toFixed(2);
        }
        
        if(document.getElementById("safeToWithdraw")) {
            document.getElementById("safeToWithdraw").innerText = Math.max(0, safeBalance).toFixed(2);
        }
      });
  });
}

// ===============================
// 💸 4. PAYOUT REQUESTS LISTENER
// ===============================
function initPayoutListener() {
  const table = document.getElementById("payoutTable");

  db.collection("payoutRequests")
    .where("status", "==", "pending")
    .orderBy("requestedAt", "desc")
    .onSnapshot((snap) => {
      table.innerHTML = "";
      if (snap.empty) {
        table.innerHTML = `<tr><td colspan="5" style="text-align:center;">No pending payouts 🎉</td></tr>`;
        return;
      }

      snap.forEach((doc) => {
        const p = doc.data();
        const date = p.requestedAt ? p.requestedAt.toDate().toLocaleString() : "N/A";
        
        table.innerHTML += `
          <tr>
            <td>${p.userEmail || p.email}</td>
            <td><strong>${p.paypalEmail || "Not Provided"}</strong></td>
            <td>R${Number(p.amount).toFixed(2)}</td>
            <td>${date}</td>
            <td>
              <button class="btn-approve" onclick="markPaid('${doc.id}', '${p.uid}', ${p.amount}, this)">
                ✅ Mark Paid
              </button>
            </td>
          </tr>`;
      });
    });
}

// ===============================
// 🏦 ADMIN WITHDRAWAL ACTION (FIXED)
// ===============================
async function processAdminPayPalWithdraw(btn) { 
    const amountInput = document.getElementById('adminWithdrawAmount');
    const emailInput = document.getElementById('adminPayPalEmail');
    const amount = parseFloat(amountInput.value);
    const paypalEmail = emailInput.value.trim();
    
    if (!paypalEmail.includes("@")) return alert("Enter a valid PayPal email."); 
    if (isNaN(amount) || amount <= 0) return alert("Enter a valid amount."); 
    
    if (confirm(`Send R${amount.toFixed(2)} to ${paypalEmail}?`)) {
        const originalText = btn.innerText;
        btn.disabled = true;
        btn.innerText = "⏳ Verifying...";

        try {
            const adminWithdrawFn = functions.httpsCallable("adminWithdraw");
            const result = await adminWithdrawFn({ amount, paypalEmail });

            if (result.data.success) {
                alert("✅ SUCCESS: Profit withdrawn safely!");
                location.reload(); 
            }
        } catch (error) {
            alert("❌ DENIED: " + error.message);
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }
}

// ===============================
// 🛠️ 5. APPROVE PAYOUT
// ===============================
async function markPaid(payoutId, userUid, amount, btn) {
  if (!confirm(`Are you sure you want to send R${amount} to this user via PayPal?`)) return;

  const originalText = btn.innerText;
  btn.disabled = true;
  btn.innerText = "⏳ Sending Cash...";

  try {
    const approvePayoutFn = functions.httpsCallable("approvePayout");
    const result = await approvePayoutFn({ payoutId });

    if (result.data?.success) {
      alert("✅ SUCCESS: Money sent and database updated!");
    } 
  } catch (err) {
    alert("❌ ERROR: " + err.message);
    btn.disabled = false;
    btn.innerText = originalText;
  }
}

// ===============================
// ✉️ 6. USER QUERIES & SEARCH
// ===============================
function initQueryListener() {
  const table = document.getElementById("queryTable");
  db.collection("queries").where("status", "==", "open").onSnapshot((snap) => {
      table.innerHTML = "";
      snap.forEach(doc => {
          const q = doc.data();
          table.innerHTML += `<tr><td>${q.email}</td><td>${q.message}</td><td><button onclick="resolveQuery('${doc.id}')">✔️ Done</button></td></tr>`;
      });
  });
}

document.getElementById("userSearchInput")?.addEventListener("input", async (e) => {
    const search = e.target.value.toLowerCase().trim();
    const table = document.getElementById("userSearchTable");
    if (search.length < 3) return;

    const snap = await db.collection("users").where("email", ">=", search).where("email", "<=", search + "\uf8ff").limit(5).get();
    table.innerHTML = "";
    snap.forEach(doc => {
        const u = doc.data();
        table.innerHTML += `<tr><td>${u.email}</td><td>R${(u.balance || 0).toFixed(2)}</td><td>${u.role}</td><td><button onclick="toggleBanUser('${doc.id}', ${u.status === 'banned'})">Ban/Unban</button></td></tr>`;
    });
});

async function resolveQuery(id) { await db.collection("queries").doc(id).update({ status: "resolved" }); }
async function toggleBanUser(id, isB) { await db.collection("users").doc(id).update({ status: isB ? "active" : "banned" }); }
function logout() { auth.signOut().then(() => window.location.href = "index.html"); }