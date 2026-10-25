import { mount } from "svelte";
import App from "./App.svelte";
import "./style.css";
import "./quiet-ui.css";
import "./ui-patterns.css";
mount(App, { target: document.getElementById("app")! });
