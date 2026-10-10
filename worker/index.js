// Weekend one is fully static: matching asset requests never reach this handler, and
// everything else falls through to the asset store (SPA fallback to index.html).
export default {
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
