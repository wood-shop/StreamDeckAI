import { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { toBase64Uri } from "../svg";
import type { App } from "../app";

let app: App;
export function bindApp(a: App): void {
	app = a;
}

/** Stream Deck Neo のインフォバー(232x50)。全体を 1 枚の pixmap として描く。 */
@action({ UUID: "jp.example.streamdeckai.infobar" })
export class InfobarAction extends SingletonAction {
	override onWillAppear(ev: WillAppearEvent): void {
		const a = ev.action;
		if (!a.isNeoInfobar() && !a.isDial()) return;
		app.register({
			id: a.id,
			kind: "infobar",
			slot: "auto",
			column: 0,
			push: (svg) => a.setFeedback({ canvas: toBase64Uri(svg) }),
		});
	}
	override onWillDisappear(ev: WillDisappearEvent): void {
		app.unregister(ev.action.id);
	}
}
