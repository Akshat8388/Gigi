// Created = alarm rings. Closed = alarm stops.
const audio = new Audio("alarm.wav");
audio.loop = true;
audio.play().catch(() => {});
