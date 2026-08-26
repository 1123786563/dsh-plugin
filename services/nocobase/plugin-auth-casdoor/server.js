// Host-provided modules stay external so the plugin shares the running
// NocoBase process's own packages (storage/plugins resolution walks up to the
// app root's node_modules).
module.exports = require('./dist/server/index.js');
