// Fills the host form from the "Detect best settings" result. Nothing is saved until the form is submitted.
document.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest("[data-apply-probe]") : null;
  if (!btn) return;
  const set = (sel, fn) => { const el = document.querySelector(sel); if (el) { fn(el); el.dispatchEvent(new Event("change", { bubbles: true })); } };
  set("#protocol", (el) => { el.value = btn.dataset.protocol; });
  set("#port", (el) => { el.value = btn.dataset.port; });
  set("input[name=tls_accept_self_signed]", (el) => { el.checked = btn.dataset.selfSigned === "1"; });
  set("#max_connections", (el) => { el.value = btn.dataset.maxConnections; });
  btn.textContent = "Applied: review the form, then Save host";
  btn.disabled = true;
});
