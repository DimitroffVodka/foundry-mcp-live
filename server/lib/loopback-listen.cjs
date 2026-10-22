// Preloaded into sandbox Foundry processes (node --require): bind every listener
// to 127.0.0.1. Foundry's `hostname` option is not a bind address, so without this
// a throwaway test instance would listen on all interfaces.
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const options = args[0];
  if (options && typeof options === "object" && options.port !== undefined) {
    args[0] = { ...options, host: "127.0.0.1" };
  } else if (typeof options === "number" || /^\d+$/.test(String(options))) {
    if (typeof args[1] === "string") args[1] = "127.0.0.1";
    else args.splice(1, 0, "127.0.0.1");
  }
  return listen.apply(this, args);
};
