// Preparing YouEye: polls /api/preparing every 2 s and, once the box is
// ready, reloads the same address, which then shows the claim page.
(function () {
  "use strict";
  var started = Date.now();
  var GRACE_MS = 60000;      // errors in the first minute just mean "starting"
  var HTTPS_SWITCH_MS = 20000; // on HTTPS a new certificate can block the probe
  var everAnswered = false;
  var switchingSince = 0;
  var openedLogForError = false;
  var $ = function (id) { return document.getElementById(id); };

  var stageNames = {
    starting: "Starting", network: "Checking the network", core_selection: "Checking the System selection",
    adopting_spine: "Starting the system service", core_convergence: "Checking the System release",
    release_convergence: "Checking the System release", system_restart: "Restarting to continue",
    preparing: "Preparing the installation", storage: "Preparing storage", incus: "Starting the container runtime",
    system_core: "Starting the system core", server_interface: "Installing the Control Panel",
    database: "Setting up the database", web_gateway: "Setting up the web gateway",
    network_shield: "Setting up the network shield", ui: "Installing the dashboard", ai: "Building the AI service",
    verifying: "Running health checks", setup: "Opening setup", complete: "Ready", retrying: "Retrying",
    needs_attention: "Needs attention"
  };

  function text(id, value) { $(id).textContent = value; }
  function show(id, on) { $(id).classList.toggle("hidden", !on); }

  function notice(message, isError) {
    var el = $("notice");
    el.textContent = message || "";
    el.classList.toggle("error", !!isError);
    show("notice", !!message);
  }

  function render(s) {
    var waiting = s.state === "restarting";
    $("bar").classList.toggle("waiting", waiting);
    $("fill").style.width = waiting ? "" : Math.max(2, s.percent) + "%";
    $("bar").setAttribute("aria-valuenow", String(s.percent));
    text("stage", stageNames[s.stage] || s.detail || "Working");
    text("percent", waiting ? "" : s.percent + "%");
    var message = "", isError = false;
    if (s.state === "needs_attention") {
      message = "Setup stopped after " + s.attempt + " attempts. " + (s.detail || "") +
        " Check the network cable and internet connection, then try again.";
      isError = true;
    } else if (s.network && !s.network.online) {
      message = "The box has no working network yet. " + (s.network.problem || "Check the network cable.");
      isError = true;
    } else if (s.network && !s.network.dns) {
      message = "The box can't look up internet names (DNS). " + (s.network.problem || "") + " It keeps trying.";
    } else if (s.state === "retrying") {
      message = "Something went wrong; trying again (attempt " + (s.attempt + 1) + " of " + s.max_attempts + "). " + (s.detail || "");
    } else if (s.state === "restarting") {
      message = "The box is restarting to continue. This page comes back by itself.";
    }
    notice(message, isError);
    show("retry", s.state === "needs_attention");
    text("logtext", s.log && s.log.length ? s.log.join("\n") : "No details yet.");
    if (isError && !openedLogForError) { $("log").open = true; openedLogForError = true; }
    if (!isError) { openedLogForError = false; }
    var parts = [];
    if (s.addresses && s.addresses.local) parts.push("http://" + s.addresses.local);
    if (s.addresses && s.addresses.ip) parts.push("http://" + s.addresses.ip);
    if (s.ca_fingerprint) {
      $("fingerprint").textContent = "Box certificate (SHA-256): " + s.ca_fingerprint +
        ". If you trust the box's certificate, check that it matches the one on the box's screen.";
      show("fingerprint", true);
    }
    if (parts.length) {
      $("addresses").textContent = "This page is also at " + parts.join(" and ") + ".";
      show("addresses", true);
    }
  }

  function showSwitching() {
    text("title", "Almost ready");
    text("stage", "Opening setup");
    text("percent", "");
    $("fill").style.width = "100%";
    notice("", false);
    show("retry", false);
  }

  function reload() { window.location.reload(); }

  // The Control Panel answers /api/ping; this page's server never does.
  function probe() {
    if (!switchingSince) switchingSince = Date.now();
    fetch("/api/ping", { cache: "no-store" }).then(function (res) {
      if (res.ok) { reload(); }
      else { maybeReloadAnyway(); }
    }, maybeReloadAnyway);
  }

  // Over HTTPS the Control Panel has a different certificate, so the browser
  // refuses the probe until the owner accepts it; reload and let it ask.
  function maybeReloadAnyway() {
    if (location.protocol === "https:" && Date.now() - switchingSince > HTTPS_SWITCH_MS) { reload(); }
  }

  function tick() {
    fetch("/api/preparing", { cache: "no-store", headers: { "Accept": "application/json" } }).then(function (res) {
      if (!res.ok) { throw new Error("status " + res.status); }
      return res.json();
    }).then(function (s) {
      everAnswered = true;
      if (s.state === "complete") { showSwitching(); probe(); return; }
      switchingSince = 0;
      text("title", "Preparing YouEye");
      render(s);
    }, function () {
      if (!everAnswered && Date.now() - started < GRACE_MS) {
        text("stage", "Starting");
        $("bar").classList.add("waiting");
        probe();
        return;
      }
      if (everAnswered) { showSwitching(); }
      else { notice("Waiting for the box to answer…", false); }
      probe();
    }).then(function () { window.setTimeout(tick, 2000); });
  }

  $("retry").addEventListener("click", function () {
    var button = $("retry");
    button.disabled = true;
    fetch("/api/preparing/retry", { method: "POST", headers: { "X-YouEye-Preparing": "retry" } }).then(function (res) {
      if (!res.ok && res.status !== 409) { notice("Retry didn't start. Wait a minute and try again.", true); }
    }, function () {}).then(function () { window.setTimeout(function () { button.disabled = false; }, 5000); });
  });

  tick();
})();
