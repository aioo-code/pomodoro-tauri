# Original audio palette

The six interaction cues and three meditation ambiences are synthesized locally by
`frontend/lib/audio-dsp.ts`. They contain no recordings or third-party samples,
require no network access and can be distributed with this application.

Stillness uses warm, slowly evolving chords. Ether layers airy harmonic tones.
Singing Bowl is an original soft resonant timbre with overlapping decays, not a
recording of a physical instrument. The sounds make no medical or therapeutic
claims. The 24-second stereo loops use periodic carriers/envelopes for seamless
boundaries, soft fade-in/out and a shared dynamics compressor. Synthesis runs in
a local worker so the interface can respond during first playback. There is no
per-second ticking or abrupt completion alarm.

The included synthesis implementation and the sound it generates may be used,
modified and redistributed with this application, including standalone builds.
The React Bits Orb has its separate license in react-bits.md.
