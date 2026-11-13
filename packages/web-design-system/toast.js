let timer = null;
/** One short message at the bottom of the page; errors are red and stay longer. */
export function toast(text, { error = false, ms = error ? 6000 : 3000 } = {}) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.toggle("error", error);
  el.classList.add("visible");
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove("visible"), ms);
}
