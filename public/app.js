/* ===== FIREBASE INIT ===== */
firebase.initializeApp({
  apiKey: "AIzaSyDBYzvleKKLKvKtkEuu8utwZHJnc70lh3E",
  authDomain: "videorewardsweb.firebaseapp.com",
  projectId: "videorewardsweb",
  storageBucket: "videorewardsweb.firebasestorage.app",
  messagingSenderId: "844494435984",
  appId: "1:844494435984:web:3011f3871a3eeefc95ca15"
});

const appCheck = firebase.appCheck();
appCheck.activate(
  new firebase.appCheck.ReCaptchaV3Provider('6LeZI1EsAAAAAOhgs3Dru3eoYQcsJjRWQhkqjB39'),
  true // Auto-refresh tokens so videos don't error out after an hour
);


const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();
const functions = firebase.app().functions("us-central1");

const MIN_PAYOUT = 15;
const REWARD_VAL = 0.50;

let currentUser;
let videoList = [];
let maxTimeWatched = 0;
let canEarn = true;

auth.onAuthStateChanged(async user => {
  if (!user) {
    location.href = "index.html";
    return;
  }
  currentUser = user;
  document.getElementById("userEmail").innerText = user.email;
  setupVideoEvents(); 
  listenBalance();
  loadVideos();
});

/* ===== VIDEO LOGIC ===== */
function setupVideoEvents() {
  const video = document.getElementById("rewardVideo");
  if (!video) return;
  video.addEventListener("click", () => { video.play().catch(() => {}); });
  video.ontimeupdate = () => {
    if (video.currentTime - maxTimeWatched > 2) {
      video.currentTime = maxTimeWatched;
      showToast("⚠️ Skipping not allowed");
    } else {
      maxTimeWatched = Math.max(maxTimeWatched, video.currentTime);
    }
  };
  video.onerror = () => { showToast("❌ Video failed to load"); };
}

async function loadVideos() {
  try {
    const list = await storage.ref("videos").listAll();
    if (!list.items.length) { showToast("No videos found"); return; }
    videoList = await Promise.all(list.items.map(item => item.getDownloadURL()));
    playRandom();
  } catch (err) { showToast("Failed to load videos"); }
}

function playRandom() {
  const video = document.getElementById("rewardVideo");
  if (!videoList.length || !video) return;
  maxTimeWatched = 0;
  canEarn = true;
  video.src = videoList[Math.floor(Math.random() * videoList.length)];
  video.load(); 
  video.play().catch(() => { showToast("▶️ Tap video to play"); });
}

/* ===== REWARD SYSTEM ===== */
async function rewardUser() {
  if (!canEarn) { showToast("⏳ Please wait..."); return; }
  const video = document.getElementById("rewardVideo");
  const earnBtn = document.getElementById("earnBtn");
  if (!video.duration || maxTimeWatched < video.duration * 0.95) {
    showToast("📺 Please watch the full video");
    return;
  }
  canEarn = false;
  earnBtn.disabled = true;
  earnBtn.innerText = "Processing...";
  try {
    const fn = functions.httpsCallable("rewarduser");
    const res = await fn({}); 
    if (res.data && res.data.reward) { showToast(`🎉 +R${res.data.reward.toFixed(2)} added!`); }
    setTimeout(() => {
        earnBtn.disabled = false;
        earnBtn.innerText = "🎁 Claim Reward (R0.50)";
        playRandom(); 
    }, 1000);
  } catch (err) {
    showToast("⛔ Error: " + err.message);
    canEarn = true;
    earnBtn.disabled = false;
    earnBtn.innerText = "🎁 Claim Reward (R0.50)";
  }
}

/* ===== BALANCE & PROGRESS ===== */
function listenBalance() {
  db.collection("users").doc(currentUser.uid).onSnapshot(doc => {
    if (!doc.exists) return;
    const data = doc.data() || {};
    const hasPending = data.hasPendingPayout || false;
    
    // We show the actual balance. Since your code sets balance to 0 on withdraw, 
    // the user will see 0.00 immediately after clicking submit.
    const bal = data.balance || 0; 

    document.getElementById("userBalance").innerText = bal.toFixed(2);
    
    const pct = Math.min((bal / MIN_PAYOUT) * 100, 100);
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const withdrawBtn = document.getElementById("withdrawBtn");

    if (progressBar) progressBar.style.width = pct + "%";

    if (hasPending) {
      // Logic for when they are waiting for you to pay them
      progressText.innerText = "⏳ Payout pending... You can keep earning!";
      progressText.style.color = "orange";
      withdrawBtn.disabled = true;
      withdrawBtn.style.background = "#ccc";
      withdrawBtn.innerText = "Processing...";
    } else if (bal >= MIN_PAYOUT) {
      progressText.innerText = "⭐ Goal reached!";
      progressText.style.color = "#28a745";
      withdrawBtn.disabled = false;
      withdrawBtn.style.background = "#28a745";
      withdrawBtn.innerText = "💸 Withdraw Now";
      withdrawBtn.onclick = requestPayout; 
    } else {
      const remaining = (MIN_PAYOUT - bal).toFixed(2);
      progressText.innerText = `R${remaining} remaining until payout`;
      progressText.style.color = "#666";
      withdrawBtn.disabled = true;
      withdrawBtn.style.background = "#eee";
      withdrawBtn.innerText = "💸 Withdraw";
    }
  });
}

/* ===== WITHDRAW MODAL LOGIC ===== */
function requestPayout() {
  const currentBal = document.getElementById("userBalance").innerText;
  const amountInput = document.getElementById("withdrawAmount");
  const modalBalDisplay = document.getElementById("modalBalDisplay");
  const modal = document.getElementById("withdrawModal");
  if (amountInput) amountInput.value = currentBal;
  if (modalBalDisplay) modalBalDisplay.innerText = currentBal;
  modal.classList.remove("hidden");
}

function closeWithdraw() {
  document.getElementById("withdrawModal").classList.add("hidden");
}

async function submitWithdraw() {
  const paypalEmail = document.getElementById("paypalEmail").value.trim();
  const btn = document.querySelector(".modal-actions button:first-child");
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(paypalEmail)) return showToast("Enter a valid PayPal email");

  const user = firebase.auth().currentUser;
  if (!user) return;

  btn.disabled = true;
  btn.innerText = "⏳ Processing...";

  try {
    const userRef = db.collection("users").doc(user.uid);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");

      const data = snap.data();
      const amount = data.balance || 0;

      if (data.hasPendingPayout) {
        throw new Error("You already have a pending payout");
      }

      if (amount < MIN_PAYOUT) {
        throw new Error(`Minimum payout is R${MIN_PAYOUT}`);
      }

      // 1️⃣ Create payout request
      const payoutRef = db.collection("payoutRequests").doc();
      tx.set(payoutRef, {
        uid: user.uid,
        userEmail: data.email,
        paypalEmail,
        amount,
        payoutMethod: "paypal",
        status: "pending",
        requestedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // 2️⃣ Move money safely
      tx.update(userRef, {
        balance: 0,
        pendingBalance: amount,
        hasPendingPayout: true
      });
    });

    closeWithdraw();
    showToast("✅ Payout requested successfully");

  } catch (err) {
    showToast(err.message || "Failed to submit payout");
    btn.disabled = false;
    btn.innerText = "Submit Withdraw";
  }
}


function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.innerText = msg;
  t.className = "toast show";
  setTimeout(() => t.className = "toast", 3000);
}

function logout() { auth.signOut().then(() => { location.href = "index.html"; }); }