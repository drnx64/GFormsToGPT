// Welcome page logic for GForm to GPT v4.6.0
// Terms acceptance lives only in the popup consent gate; this page is
// informational (setup steps + the full legal text).
document.addEventListener("DOMContentLoaded", () => {
  const hash = window.location.hash;
  if (hash && hash.length > 1) {
    try {
      const el = document.querySelector(hash);
      if (el) el.scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      /* malformed hash selector — nothing to scroll to */
    }
  }
});
