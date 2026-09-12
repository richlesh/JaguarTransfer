// electron-builder afterPack hook (macOS only): strip extended attributes from
// the packaged .app so code-signing/notarization isn't tripped up by stray xattrs.
const { execFileSync } = require("child_process");
const fs = require("fs");

exports.default = async function (context) {
  if (process.platform !== "darwin") return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  if (!fs.existsSync(appPath)) return;
  execFileSync("xattr", ["-cr", appPath]);
};
