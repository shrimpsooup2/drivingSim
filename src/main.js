/**
 * Entry point.
 *
 * The whole simulator is native ES modules with no build step: this file is
 * loaded directly by the browser. Serve the folder over http (`npm start`) --
 * opening index.html from the filesystem will not work, because browsers block
 * module imports over file://.
 */
import { App, showFatal } from './app/App.js';

const root = document.getElementById('app');
const viewport = document.getElementById('viewport');

try {
  if (!root) throw new Error('missing #app element');
  globalThis.ftcSim = new App(root);
} catch (err) {
  console.error(err);
  if (viewport) showFatal(viewport, err);
}
