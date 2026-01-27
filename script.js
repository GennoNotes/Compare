
// Sanity test: confirm this file loads and defines a global
console.log("script.js loaded; attaching window.compare");
window.compare = function () {
  alert("compare is callable!");
};
