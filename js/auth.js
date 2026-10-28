/* NoFaceNoCase — login page. fake Cognito flow. */

const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const errBox = document.getElementById("loginError");
const errText = document.getElementById("loginErrorText");

// already signed in? skip to the registry
if (getSessionUser()) window.location.href = "dashboard.html";

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  errBox.classList.add("hidden");

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!email || !password) {
    errText.textContent = "Enter both your staff email and password.";
    errBox.classList.remove("hidden");
    return;
  }

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spin"></span> Signing in…';

  const res = await apiLogin(email, password); // fake login (see api.js)

  if (res.success) {
    sessionStorage.setItem("nfnc_user", JSON.stringify(res.user));
    sessionStorage.setItem("nfnc_token", res.token); // pretend JWT
    window.location.href = "dashboard.html";
  } else {
    errText.textContent = res.message;
    errBox.classList.remove("hidden");
    loginBtn.disabled = false;
    loginBtn.textContent = "Sign in";
  }
});
