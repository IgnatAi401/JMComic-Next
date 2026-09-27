import { mountShell } from "../ui/shell.js";
import { mountReadingControls } from "../ui/reading-controls.js";
mountShell();
mountReadingControls(document.querySelector("#settings-reading"));
