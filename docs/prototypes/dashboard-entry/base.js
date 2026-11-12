(() => {
  let timer = 0;
  const start = () => {
    window.clearTimeout(timer);
    document.body.classList.remove("play");
    // 强制重排，保证重播时动画重新开始。
    void document.body.offsetWidth;
    document.body.classList.add("play");
  };
  const auto = () => {
    timer = window.setTimeout(start, 900);
  };
  document.querySelectorAll("[data-replay]").forEach((button) => {
    button.addEventListener("click", start);
  });
  document.querySelectorAll("[data-enter]").forEach((button) => {
    button.addEventListener("click", start);
  });
  window.addEventListener("load", auto);
})();
