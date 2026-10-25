// Aurora's first-run guided tour: every word, step and arrow setting lives here.
// The tour itself (spotlight, arrow, tooltip) is in app.js and reads this file.
//
// HOW TO EDIT
//   steps       The shared step definitions. Change a title or text here and every platform picks it up.
//   platforms   One block per platform (phone = Android phone app, tv = Android TV app, web = browser).
//               "order"     the steps in the order they appear. Reorder or remove ids to change the tour.
//               "overrides" per-step changes for that platform only (text, placement, targets...).
//   version     Raise it to show the tour again to everyone (one device = one "seen" flag).
//
// A STEP
//   title, text   What the tooltip says (one or two lines).
//   centered      true = a centered card with no spotlight and no arrow (the welcome card).
//   targets       What to spotlight. A list of "groups"; a group is a selector, or a list of alternative
//                 selectors (the first one that is visible wins, so one step works on a phone's bottom tab
//                 bar and on the top bar alike). The spotlight covers all of the groups together.
//   any           true = it is enough that one group is found (default: every group must be found).
//   route         The page the step lives on ("home", "settings"). Aurora goes there first.
//   prepare       "profileMenu" opens the profile menu before looking for the target.
//   placement     Where the tooltip goes: "auto" (decided from the target's real position), or "top",
//                 "bottom", "left", "right" (the side of the target the tooltip sits on).
//   padding       Extra space around the spotlight, in pixels.
//   loaded        A selector that shows the step's page has finished drawing. If it is there and the target
//                 still isn't, the step is skipped straight away instead of waiting (see wait).
//   wait          How long to wait for the target to appear, in milliseconds. A target that never
//                 shows up (no watch history yet, Live TV switched off...) just skips the step.
//   nextLabel     Text of the Next button (the last step says "Start watching").
window.AURORA_TOUR = {
  version: 1,

  steps: {
    welcome: {
      centered: true, route: 'home',
      title: 'Welcome to Aurora',
      text: 'Movies, shows and live TV in one app, on every screen.',
    },
    browse: {
      route: 'home', any: true, placement: 'auto', padding: 8,
      title: 'Movies and shows',
      text: 'Browse, search and resume where you left off. The next episode is ready to go.',
      targets: [
        ['#nav .nav-links [data-route="tv"]', '.mobile-tabs [data-route="tv"]'],
        ['#nav .nav-links [data-route="movies"]', '.mobile-tabs [data-route="movies"]'],
      ],
    },
    search: {
      route: 'home', placement: 'auto', padding: 8,
      title: 'Search',
      text: 'Find any movie or show by its title, or by an actor.',
      targets: [['#search-toggle']],
    },
    resume: {
      route: 'home', placement: 'auto', padding: 6, wait: 1500,
      title: 'Continue watching',
      text: 'Pick up right where you stopped, on any screen.',
      targets: [['[data-row="continue-watching"] .row-title'], ['[data-row="continue-watching"] .row-wrap']],
    },
    livetv: {
      route: 'home', placement: 'auto', padding: 8,
      title: 'Live TV',
      text: 'Channels are organized into categories, with a program guide.',
      targets: [['#nav .nav-links [data-route="livetv"]', '.mobile-tabs [data-route="livetv"]']],
    },
    favorites: {
      route: 'home', placement: 'auto', padding: 8,
      title: 'Favorites',
      text: 'Save any movie, show or channel here.',
      targets: [['#nav .nav-links [data-route="mylist"]', '.mobile-tabs [data-route="mylist"]']],
    },
    settingsMenu: {
      route: 'home', prepare: 'profileMenu', placement: 'auto', padding: 4,
      title: 'Settings',
      text: 'Open your profile menu, then Settings, for your account and Aurora\'s status.',
      targets: [['#profile-dropdown [data-action="settings"]']],
    },
    account: {
      route: 'settings', placement: 'auto', padding: 8, wait: 6000, loaded: '.settings-page .feedback-section',
      title: 'Your account',
      text: 'See your plan, how many devices you can use and when it expires. You can request an extension right here.',
      targets: [['[data-account]']],
    },
    status: {
      route: 'settings', placement: 'auto', padding: 8, wait: 6000, loaded: '.settings-page .feedback-section', nextLabel: 'Start watching',
      title: 'Is Aurora online?',
      text: 'The status light shows whether Aurora is online, so you know if a problem is on your end or mine.',
      targets: [['[data-service-status]']],
    },
  },

  platforms: {
    // Android phone app
    phone: {
      order: ['welcome', 'browse', 'search', 'resume', 'livetv', 'favorites', 'settingsMenu', 'account', 'status'],
      overrides: {},
    },
    // Android TV app (remote control: OK, arrows and Back)
    tv: {
      order: ['welcome', 'browse', 'search', 'resume', 'livetv', 'favorites', 'settingsMenu', 'account', 'status'],
      overrides: {
        search: { text: 'Press OK on the magnifier to find any movie or show by its title.' },
        favorites: { text: 'Hold OK on any item to save it here.' },
        settingsMenu: { text: 'Press OK on your profile picture, then choose Settings, for your account and Aurora\'s status.' },
      },
    },
    // Aurora in a web browser
    web: {
      order: ['welcome', 'browse', 'search', 'resume', 'livetv', 'favorites', 'settingsMenu', 'account', 'status'],
      overrides: {},
    },
  },
};
