import { action, SingletonAction, type KeyDownEvent, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import { toDataUri } from "../svg";
import type { App } from "../app";

type Settings = { slot?: number | string };

let app: App;
export function bindApp(a: App): void {
	app = a;
}

function slotOf(s: Settings | undefined): number | "auto" {
	const n = Number(s?.slot);
	return Number.isInteger(n) && n >= 1 && n <= 16 ? n : "auto";
}

@action({ UUID: "jp.example.streamdeckai.space" })
export class SpaceAction extends SingletonAction<Settings> {
	override onWillAppear(ev: WillAppearEvent<Settings>): void {
		if (!ev.action.isKey()) return;
		const a = ev.action;
		app.register({
			id: a.id,
			kind: "space",
			slot: slotOf(ev.payload.settings),
			column: a.coordinates?.column ?? 0,
			push: (svg) => a.setImage(toDataUri(svg)),
		});
	}
	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		app.unregister(ev.action.id);
	}
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		const s = app.surfaces.get(ev.action.id);
		if (s) {
			s.slot = slotOf(ev.payload.settings);
			s.last = undefined;
		}
	}
	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const s = app.surfaces.get(ev.action.id);
		// 成功マークは出さない。失敗(空スロット)のときだけ警告。
		if (!s || !app.pressSpace(s)) await ev.action.showAlert();
	}
}
