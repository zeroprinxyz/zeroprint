import "./style.css";
import { viewFootprint } from "./footprint.js";
import { crowd, runScene } from "./scenes.js";

runScene(document.getElementById("fx"), crowd());
viewFootprint(document.getElementById("view"), new URLSearchParams(location.search));
