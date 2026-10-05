import streamDeck from "@elgato/streamdeck";
import { App } from "./app";
import { bindApp as bindInfobar, InfobarAction } from "./actions/infobar";
import { bindApp as bindSpace, SpaceAction } from "./actions/space";
import { bindApp as bindTab, TabAction } from "./actions/tab";

const app = new App({ log: (m) => streamDeck.logger.info(m) });
bindSpace(app);
bindTab(app);
bindInfobar(app);

streamDeck.actions.registerAction(new SpaceAction());
streamDeck.actions.registerAction(new TabAction());
streamDeck.actions.registerAction(new InfobarAction());

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	void app.applySettings(ev.settings);
});

await streamDeck.connect();
await app.applySettings(await streamDeck.settings.getGlobalSettings());
app.startTimer();
