import { getSetting, MODULE_ID } from './settings.js';
import { getTokenMusic } from './token.js';

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

let ambiencePaused = []; // kept for safety, no longer used for ambience

function getCurrentMusic(combat) {
	return combat._combatMusic || combat.getFlag(MODULE_ID, 'currentMusic') || '';
}

/* -------------------------------------------- */
/*  Sound helpers                               */
/* -------------------------------------------- */

// Is this sound (PlaylistSound or Playlist) currently playing?
function isPlaying(sound) {
	if (sound.documentName === 'PlaylistSound') return sound.playing;
	return sound.sounds.contents.some((s) => s.playing);
}

// Is this sound currently paused (has a pausedTime)?
function isPaused(sound) {
	if (sound.documentName === 'PlaylistSound') return !sound.playing && sound.pausedTime != null;
	return sound.sounds.contents.some((s) => !s.playing && s.pausedTime != null);
}

// Start playing a sound. If it's paused, resume it. If it's already playing, do nothing.
async function playSound(sound) {
	if (sound.documentName === 'PlaylistSound') {
		if (sound.playing) return; // already playing
		if (isPaused(sound)) await sound.update({ playing: true }); // resume
		else await sound.parent.playSound(sound); // fresh start
	} else {
		if (isPlaying(sound)) return; // already playing
		// For a playlist, resume any paused sounds, or start fresh.
		const pausedSounds = sound.sounds.contents.filter((s) => isPaused(s));
		if (pausedSounds.length > 0) {
			for (const s of pausedSounds) await s.update({ playing: true });
		} else {
			await sound.playAll();
		}
	}
}

// Pause a sound. If it's not playing, do nothing.
async function pauseSound(sound) {
	if (sound.documentName === 'PlaylistSound') {
		if (!sound.playing) return;
		await sound.update({ playing: false, pausedTime: sound.sound?.currentTime ?? null });
	} else {
		for (const s of sound.sounds.contents.filter((s) => s.playing)) {
			await s.update({ playing: false, pausedTime: s.sound?.currentTime ?? null });
		}
	}
}

// Stop a sound completely (clears pausedTime).
async function stopSound(sound) {
	if (sound.documentName === 'PlaylistSound') {
		await sound.parent.stopSound(sound);
	} else {
		await sound.stopAll();
	}
}

/* -------------------------------------------- */
/*  Ambience                                    */
/* -------------------------------------------- */

function pauseAllMusic(combat) {
	const combatPlaylistIds = new Set(getCombatMusic().map((p) => p.id));
	const playing = game.playlists.playing
		.filter((p) => !combatPlaylistIds.has(p.id))
		.flatMap((p) => p.sounds.contents.filter((s) => s.playing));

	// Note exactly what was playing so we can restart it after combat.
	const noted = playing.map((s) => stringifyMusic(s));
	combat.setFlag(MODULE_ID, 'preCombatMusic', noted);

	for (const s of playing) s.update({ playing: false, pausedTime: s.sound?.currentTime ?? null });
}



/* -------------------------------------------- */
/*  Combat music tracking                       */
/* -------------------------------------------- */

export function setCombatMusic(sound, combat = game.combat, token) {
	if (combat) {
		combat.update({
			[`flags.${MODULE_ID}`]: {
				currentMusic: stringifyMusic(sound),
				token,
			},
		});
	}
}

/* -------------------------------------------- */
/*  Core: switch to a new track                 */
/* -------------------------------------------- */

// Switch combat music to `music`. Stops whatever was playing before (unless it's the same).
// If `pausePrevious` is true, pauses instead of stops (so it can be resumed later).
async function switchTo(combat, music, token, { pausePrevious = false } = {}) {
	const oldMusic = getCurrentMusic(combat);
	const newSound = parseMusic(music);
	if ('error' in newSound) {
		if (newSound.error === 'not found') ui.notifications.error(`${newSound.rgx[2] ? 'Track' : 'Playlist'} not found.`);
		if (newSound.error === 'invalid flag') ui.notifications.error('Bad configuration.');
		return;
	}

	// If already playing this exact music, do nothing.
	if (oldMusic === music && isPlaying(newSound)) return;

	// Stop or pause the previous music.
	if (oldMusic && oldMusic !== music) {
		const oldSound = parseMusic(oldMusic);
		if (!('error' in oldSound)) {
			if (pausePrevious) await pauseSound(oldSound);
			else await stopSound(oldSound);
		}
	}

	// Play the new music.
	await playSound(newSound);

	// Update tracking.
	combat._combatMusic = music;
	setCombatMusic(newSound, combat, token);
}

/* -------------------------------------------- */
/*  Turn music logic                            */
/* -------------------------------------------- */

export async function updateTurnMusic(combat, changes) {
	// Only fire on actual turn/round changes, not flag updates.
	if (changes && !('turn' in changes) && !('round' in changes)) return;
	if (!combat.started || getCombatMusic().length === 0) return;

	const combatantToken = combat.combatant?.token ?? null;

	// ── Step 1: Does the current combatant have active personal music? ──
	const turnMusic = combatantToken ? getTokenMusic(combatantToken) : null;
	if (turnMusic) {
		const wasInterrupted = combat.getFlag(MODULE_ID, 'encounterInterrupted');
		if (!wasInterrupted) {
			// Pause the encounter track so we can resume it later.
			const encounterMusic = getEncounterMusic(combat);
			if (encounterMusic) {
				const encounterSound = parseMusic(encounterMusic);
				if (!('error' in encounterSound)) await pauseSound(encounterSound);
				await combat.setFlag(MODULE_ID, 'encounterInterrupted', true);
				await combat.setFlag(MODULE_ID, 'pausedEncounterMusic', encounterMusic);
			}
		}
		await switchTo(combat, turnMusic, combatantToken.id);
		return;
	}

	// ── Step 2: Were we interrupted last turn? Resume the encounter track. ──
	const wasInterrupted = combat.getFlag(MODULE_ID, 'encounterInterrupted');
	if (wasInterrupted) {
		// Stop or pause the turn music based on pauseTrack setting.
		const currentMusic = getCurrentMusic(combat);
		if (currentMusic) {
			const currentSound = parseMusic(currentMusic);
			if (!('error' in currentSound)) {
				if (getSetting('pauseTrack')) await pauseSound(currentSound);
				else await stopSound(currentSound);
			}
		}
		// Resume the paused encounter track.
		const pausedEncounterMusic = combat.getFlag(MODULE_ID, 'pausedEncounterMusic');
		if (pausedEncounterMusic) {
			const encounterSound = parseMusic(pausedEncounterMusic);
			if (!('error' in encounterSound)) await playSound(encounterSound);
			combat._combatMusic = pausedEncounterMusic;
			setCombatMusic(parseMusic(pausedEncounterMusic), combat, '');
		}
		await combat.setFlag(MODULE_ID, 'encounterInterrupted', false);
		await combat.unsetFlag(MODULE_ID, 'pausedEncounterMusic');
		return;
	}

	// ── Step 3: Resolve and play the encounter track. ──
	const encounterMusic = getEncounterMusic(combat);
	if (!encounterMusic) return;
	// Pause the previous encounter track if pauseTrack is enabled, otherwise stop it.
	await switchTo(combat, encounterMusic, '', { pausePrevious: getSetting('pauseTrack') });
}

// Resolve what the encounter-wide music should be:
// Manual override > Combat Theme > Trait music > Generic playlist
function getEncounterMusic(combat) {
	// Manual override.
	const overrideMusic = combat.getFlag(MODULE_ID, 'overrideMusic');
	if (overrideMusic) return overrideMusic;

	// Combat Theme token (highest priority wins).
	const themeMap = new Map();
	for (const combatant of combat.combatants.contents) {
		if (!combatant.token) continue;
		const token = combatant.token;
		if (!token.getFlag(MODULE_ID, 'combatTheme')) continue;
		const music = getTokenMusic(token);
		if (!music) continue;
		themeMap.set({ token: token.id, music }, token.getFlag(MODULE_ID, 'priority') ?? 10);
	}
	if (themeMap.size > 0) {
		const highest = getHighestPriority(themeMap);
		return pick(highest).music;
	}

	// Trait-based music (PF2e).
	const traitRules = getSetting('traitRules') ?? [];
	if (traitRules.length > 0) {
		const hostileTraits = new Set();
		for (const combatant of combat.combatants.contents) {
			if (!combatant.token?.actor) continue;
			if (combatant.token.disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) continue;
			for (const trait of (combatant.token.actor.system?.traits?.value ?? []))
				hostileTraits.add(trait.toLowerCase());
		}
		const matching = traitRules.filter((r) => r.trait && hostileTraits.has(r.trait.toLowerCase()) && r.music);
		if (matching.length > 0) {
			return matching.reduce((a, b) => b.priority > a.priority ? b : a).music;
		}
	}

	// Generic combat playlist.
	const base = getSetting('defaultPlaylist');
	const combatPlaylists = new Map(getCombatMusic().map((p) => [{ token: '', music: p.id }, +(p.id === base)]));
	for (const combatant of game.combat.combatants.contents) {
		if (!combatant.token) continue;
		const music = getTokenMusic(combatant.token);
		const priority = combatant.token.getFlag(MODULE_ID, 'priority') ?? 10;
		const token = combatant.token.id;
		if (music && combatant.token.getFlag(MODULE_ID, 'turnOnly') === false)
			combatPlaylists.set({ token, music }, priority);
	}
	const highest = getHighestPriority(combatPlaylists);
	if (!highest.length) return null;
	return pick(highest).music || null;
}

/* -------------------------------------------- */
/*  Combat start / end                          */
/* -------------------------------------------- */

async function playCombatMusic(combat) {
	if (getCombatMusic().length === 0) return;
	if (getSetting('pauseAmbience')) await pauseAllMusic(combat);
	await updateTurnMusic(combat);
}

async function resumePlaylists(combat) {
	// Stop combat music.
	const currentMusic = getCurrentMusic(combat);
	if (currentMusic) {
		const sound = parseMusic(currentMusic);
		if (!('error' in sound)) await stopSound(sound);
	}
	combat._combatMusic = '';
	await combat.unsetFlag(MODULE_ID, 'encounterInterrupted');
	await combat.unsetFlag(MODULE_ID, 'pausedEncounterMusic');

	// Resume whatever was playing before combat, by name.
	const preCombatMusic = combat.getFlag(MODULE_ID, 'preCombatMusic') ?? [];
	for (const flag of preCombatMusic) {
		const sound = parseMusic(flag);
		if (!('error' in sound)) await playSound(sound);
	}
	await combat.unsetFlag(MODULE_ID, 'preCombatMusic');
}

/* -------------------------------------------- */
/*  Utilities (exported for other modules)      */
/* -------------------------------------------- */

export function parseMusic(flag) {
	const rgx = /(\w+)\.?(\w+)?/.exec(flag);
	if (!rgx) return { error: 'invalid flag' };
	const playlist = game.playlists.get(rgx[1]),
		sound = playlist?.sounds.get(rgx[2]);
	return sound ?? playlist ?? { error: 'not found', rgx };
}

export function stringifyMusic(sound) {
	return (sound?.parent ? sound.parent.id + '.' + sound.id : sound?.id) ?? '';
}

export function getCombatMusic() {
	return game.playlists.contents.filter((p) => p.getFlag(MODULE_ID, 'combat'));
}

export function getHighestPriority(map) {
	const max = Math.max(...map.values());
	return [...map].filter(([p, v]) => v === max).map(([p, v]) => p);
}

export function pick(array) {
	return array[~~(Math.random() * array.length)];
}

// Legacy export — kept for compatibility with encounter.js / token.js callers.
export async function updateCombatMusic(combat, music, token) {
	await switchTo(combat, music, token);
}

export function setTokenConfig(token, resource, sounds, priority = 10, turnOnly = false, active = false) {
	sounds = (sounds ?? []).sort((a, b) => b[1] - a[1]);
	token.setFlag(MODULE_ID, {
		active,
		resource,
		priority,
		musicList: sounds.map(([sound, threshold]) => [stringifyMusic(sound), threshold]),
		turnOnly,
	});
}

window.CombatMusicMaster = {
	setCombatMusic,
	setTokenConfig,
};

Hooks.once('setup', () => {
	if (game.user.isGM) {
		Hooks.on('combatStart', playCombatMusic);
		Hooks.on('updateCombat', updateTurnMusic);
		Hooks.on('deleteCombat', resumePlaylists);
	}
});
