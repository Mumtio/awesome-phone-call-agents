// Opening animation: the rider rides a short route, with the name underneath.
// Plays once per browser tab session, not inside the embedded phones, and
// briefly for people who prefer reduced motion. A click or key skips it.
// Loaded as a classic script at the top of <body>, so it covers the page before first paint.
(function () {
  if (window.top !== window.self) return;
  var KEY = "routeready-splash";
  try {
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
  } catch (error) {
    // Storage can be blocked; the animation simply plays.
  }
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;
  root.classList.add("splash-on");

  var splash = document.createElement("div");
  splash.className = "splash" + (reduced ? " reduced" : "");
  splash.setAttribute("aria-hidden", "true");
  splash.innerHTML =
    '<svg viewBox="0 0 180 64" role="presentation">' +
    '<defs><path id="rr-splash-route" pathLength="1" d="M10 48 C 50 48, 62 22, 92 26 S 140 48, 170 22"></path></defs>' +
    '<use href="#rr-splash-route" class="track"></use>' +
    '<use href="#rr-splash-route" class="ridden"></use>' +
    '<circle class="goal" cx="170" cy="22" r="6"></circle>' +
    '<g class="scooter"><g transform="scale(-1 1)"><text x="-13" y="-8" font-size="24">🛵</text></g></g>' +
    "</svg>" +
    '<p class="name">Route<span>Ready</span></p>';
  document.body.prepend(splash);

  // The rider follows the route from the first frame, whatever else the page is still loading.
  var route = splash.querySelector("#rr-splash-route");
  var scooter = splash.querySelector(".scooter");
  var length = route.getTotalLength();
  var ride = function (progress) {
    var point = route.getPointAtLength(length * progress);
    scooter.setAttribute("transform", "translate(" + point.x + " " + point.y + ")");
  };
  var ease = function (t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  var started = null;
  var duration = reduced ? 1 : 1300;
  var delay = reduced ? 0 : 150;
  ride(0);
  var frame = function (now) {
    if (started === null) started = now;
    var t = Math.min(1, Math.max(0, (now - started - delay) / duration));
    ride(ease(t));
    if (t < 1 && splash.isConnected) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    splash.classList.add("leaving");
    root.classList.remove("splash-on");
    setTimeout(function () {
      splash.remove();
    }, 550);
  }
  splash.addEventListener("click", finish);
  document.addEventListener("keydown", finish, { once: true });
  setTimeout(finish, reduced ? 500 : 1900);
})();
