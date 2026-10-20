// Phone header: items marked data-m are hidden on small screens (CSS) and shown in this
// menu instead, copied fresh on every open so the network switch shows its current state.
export function mountMobileNav() {
  const top = document.querySelector("header.top");
  const btn = top?.querySelector(".mnav-btn");
  if (!btn) return;
  const panel = document.createElement("nav");
  panel.className = "mnav";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Menu");
  top.after(panel);
  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!panel.hidden) return close();
    panel.innerHTML = [...top.querySelectorAll("[data-m]")].map((el) => el.outerHTML).join("");
    panel.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    panel.style.top = `${top.getBoundingClientRect().bottom + 6}px`;
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
  });
  panel.addEventListener("click", (e) => e.target.closest("a") && close());
  document.addEventListener("click", (e) => !panel.hidden && !panel.contains(e.target) && close());
  addEventListener("keydown", (e) => e.key === "Escape" && close());
  addEventListener("resize", close);
}
