/* Wetter-Symbole für Live-Tipps (TV-Welcome-Screen und „Meine Buchung“). Linien-Icons, Farbe = currentColor. */
(function (root) {
    'use strict';
    const cloud = '<path d="M7 18.5h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>';
    const smallCloud = '<path d="M9 19h8.5a3.4 3.4 0 0 0 .5-6.76A4.7 4.7 0 0 0 9 11.3 3.9 3.9 0 0 0 9 19z"/>';
    const sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>';
    const sunSmall = '<circle cx="8.5" cy="8.5" r="3"/><path d="M8.5 2.5v1.3M2.5 8.5h1.3M4.3 4.3l.9.9M12.7 4.3l-.9.9M4.3 12.7l.9-.9"/>';
    const moon = '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>';
    const moonSmall = '<path d="M11.5 9.6A4.4 4.4 0 0 1 6.4 4.5a4.4 4.4 0 1 0 5.1 5.1z"/>';
    const ICONS = {
        sun, moon,
        partly: sunSmall + smallCloud,
        'partly-night': moonSmall + smallCloud,
        cloud,
        fog: '<path d="M7 14.5h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 5.6 4.5 4.5 0 0 0 7 14.5z"/><path d="M4 18h16M6 21h12"/>',
        drizzle: '<path d="M7 15h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 6.1 4.5 4.5 0 0 0 7 15z"/><path d="M9 18v.5M13 18v.5M11 20.5v.5M15 20.5v.5"/>',
        rain: '<path d="M7 15h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 6.1 4.5 4.5 0 0 0 7 15z"/><path d="m9 17.5-1 3M13 17.5l-1 3M17 17.5l-1 3"/>',
        showers: sunSmall + '<path d="M9 16h8.5a3.4 3.4 0 0 0 .5-6.76A4.7 4.7 0 0 0 9 8.3 3.9 3.9 0 0 0 9 16z"/><path d="m11 18.5-.8 2.5M15 18.5l-.8 2.5"/>',
        sleet: '<path d="M7 15h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 6.1 4.5 4.5 0 0 0 7 15z"/><path d="m9 17.5-1 3M16 18.5v.01M12.5 20.5v.01"/>',
        snow: '<path d="M7 14.5h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 5.6 4.5 4.5 0 0 0 7 14.5z"/><path d="M9 17.5v.01M12 19.5v.01M15 17.5v.01M10.5 21.5v.01M13.5 21.5v.01"/>',
        storm: '<path d="M7 15h10.2a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 6.1 4.5 4.5 0 0 0 7 15z"/><path d="m12.5 15.5-2 3.5h3l-2 3.5"/>'
    };
    root.liveWeatherIcon = function (key, cls) {
        return `<svg class="${cls || 'wx'}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ICONS.cloud}</svg>`;
    };
})(window);
