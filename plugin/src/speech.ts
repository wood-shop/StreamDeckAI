import type { PsRunner } from "./powershell";

/** Windows 標準の音声合成(System.Speech)。日本語の音声(ja-JP)を自動選択する。 */
export const SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
  $v = $null
  if ($env:SDAI_VOICE) { $v = $voices | Where-Object { $_.VoiceInfo.Name -eq $env:SDAI_VOICE } | Select-Object -First 1 }
  if (-not $v) { $v = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ja-JP' } | Select-Object -First 1 }
  if (-not $v) { [Console]::Error.WriteLine('no ja-JP voice installed'); exit 3 }
  $s.SelectVoice($v.VoiceInfo.Name)
  $r = 0
  [void][int]::TryParse($env:SDAI_RATE, [ref]$r)
  $s.Rate = [Math]::Max(-10, [Math]::Min(10, $r))
  $s.Volume = 100
  $s.Speak($env:SDAI_TEXT)
} finally { $s.Dispose() }
`;

/** 効果音のみ: Windows の system sound(SystemSounds)を 1 つ鳴らす。追加ソフト不要。 */
export const SOUND_NAMES = ["Asterisk", "Exclamation", "Hand", "Beep", "Question"] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export const SOUND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
switch ($env:SDAI_SOUND) {
  'Exclamation' { $snd = [System.Media.SystemSounds]::Exclamation }
  'Hand'        { $snd = [System.Media.SystemSounds]::Hand }
  'Beep'        { $snd = [System.Media.SystemSounds]::Beep }
  'Question'    { $snd = [System.Media.SystemSounds]::Question }
  default       { $snd = [System.Media.SystemSounds]::Asterisk }
}
$snd.Play()
Start-Sleep -Milliseconds 1500
`;

export interface SpeakerOptions {
	run: PsRunner;
	voiceName: () => string;
	rate: () => number;
	log?: (msg: string) => void;
	maxQueue?: number;
}

/** 読み上げを 1 件ずつ順番に再生する。たまりすぎたら古いものを捨てる。 */
export class Speaker {
	#queue: Array<{ text: string } | { sound: SoundName }> = [];
	#busy = false;
	#opts: SpeakerOptions;
	spoken: string[] = [];
	/** 鳴らした効果音(確認用) */
	sounds: SoundName[] = [];

	constructor(opts: SpeakerOptions) {
		this.#opts = opts;
	}

	get pending(): number {
		return this.#queue.length + (this.#busy ? 1 : 0);
	}

	enqueue(text: string): void {
		this.#push({ text });
	}

	/** 効果音を鳴らす(読み上げと同じ順番待ちに並べる)。 */
	enqueueSound(sound: SoundName): void {
		this.#push({ sound });
	}

	#push(item: { text: string } | { sound: SoundName }): void {
		this.#queue.push(item);
		const max = this.#opts.maxQueue ?? 3;
		while (this.#queue.length > max) this.#queue.shift();
		void this.#pump();
	}

	async #pump(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			for (let item = this.#queue.shift(); item !== undefined; item = this.#queue.shift()) {
				if ("sound" in item) {
					this.sounds.push(item.sound);
					if (this.sounds.length > 50) this.sounds.shift();
					const r = await this.#opts.run(SOUND_SCRIPT, { SDAI_SOUND: item.sound }, 15_000);
					if (r.code !== 0) this.#opts.log?.(`sound failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
					continue;
				}
				const text = item.text;
				this.spoken.push(text);
				if (this.spoken.length > 50) this.spoken.shift();
				const r = await this.#opts.run(
					SPEECH_SCRIPT,
					{ SDAI_TEXT: text, SDAI_VOICE: this.#opts.voiceName(), SDAI_RATE: String(this.#opts.rate()) },
					60_000,
				);
				if (r.code !== 0) this.#opts.log?.(`speech failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
			}
		} finally {
			this.#busy = false;
		}
	}
}
