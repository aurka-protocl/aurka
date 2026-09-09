// Compatibility entrypoint: the canonical frontend lives in apps/trader.
// Keeping this re-export avoids a second product shell for any old local script.
import "../../trader/src/index.css";

export { default } from "../../trader/src/App";
