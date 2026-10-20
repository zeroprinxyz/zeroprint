import "./style.css";
import { viewFootprint } from "./footprint.js";
import { crowd, runScene } from "./scenes.js";
import { mountMobileNav } from "./mnav.js";

mountMobileNav();

runScene(document.getElementById("fx"), crowd());
viewFootprint(document.getElementById("view"), new URLSearchParams(location.search));
