// The Market website's only script: filters the app cards of the page as you type.
// The page works without it; the search box stays hidden until this runs.
(function () {
  'use strict';
  var form = document.getElementById('search');
  var input = document.getElementById('search-input');
  var status = document.getElementById('search-status');
  var empty = document.getElementById('search-empty');
  if (!form || !input || !status || !empty) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-search]'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('[data-section]'));
  form.hidden = false;
  form.addEventListener('submit', function (event) { event.preventDefault(); });

  function apply() {
    var terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    var shown = {};
    var any = false;
    cards.forEach(function (card) {
      var text = card.getAttribute('data-search') || '';
      var match = terms.every(function (term) { return text.indexOf(term) !== -1; });
      card.hidden = !match;
      any = any || match;
      // An app can be on the page twice (curation and its category); count it once. Bundles are not apps.
      if (match && card.getAttribute('data-kind') === 'app') shown[card.getAttribute('data-id')] = true;
    });
    sections.forEach(function (section) {
      var visible = section.querySelectorAll('[data-search]:not([hidden])').length;
      var counter = section.querySelector('.count');
      if (counter) counter.textContent = String(visible);
      section.hidden = terms.length > 0 && visible === 0;
    });
    var count = Object.keys(shown).length;
    empty.hidden = !terms.length || any;
    status.textContent = terms.length ? (count === 1 ? '1 app' : count + ' apps') : '';
  }
  input.addEventListener('input', apply);
  if (input.value) apply();
}());
