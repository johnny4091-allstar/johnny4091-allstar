' Aurora's first-run guided tour for Roku: every word, step and arrow setting lives here.
' The tour itself (spotlight, arrow, tooltip, remote handling) is in Tour.brs.
'
' HOW TO EDIT
'   tourSettings()   version (raise it to show the tour again to everyone), sizes, and whether the arrow bounces.
'                    Roku has no "reduce motion" setting for apps to read, so set animate to false to stop the bounce.
'   tourSteps()      The steps, in the order they appear. Reorder or delete entries to change the tour.
'
' A STEP
'   id, title, text   What the tooltip says (one or two lines).
'   center            true = a centered card with no spotlight and no arrow (the welcome card).
'   tiles             What to spotlight, found on the Home screen by what it IS, never by a position:
'                       { action: "movies" }       a tile in the Browse row (movies, shows, search, tour, signout)
'                       { row: "Continue Watching" } the first poster in the row with that title
'                     The spotlight covers all of them together.
'   any               true = it is enough that one of the tiles is found (default: every tile must be found).
'   placement         "auto" (decided from where the target really is), or "top", "bottom", "left", "right":
'                     the side of the target the tooltip sits on.
'   padding           Extra space around the spotlight, in pixels (default: tourSettings().padding).
'
' A step whose tiles aren't on this screen is left out (this Roku app has no Live TV, Favorites or Settings
' screens yet, so those steps stay in the list and show up on their own the day those tiles exist).
function tourSettings() as object
    return {
        version: 1
        animate: true
        width: 560
        welcomeWidth: 640
        arrow: 100
        padding: 10
        margin: 40
    }
end function

function tourSteps() as object
    return [
        { id: "welcome", center: true, title: "Welcome to Aurora", text: "Movies, shows and live TV in one app, on every screen." }
        { id: "browse", any: true, placement: "auto", title: "Movies and shows", text: "Browse, search and resume where you left off. The next episode is ready to go.", tiles: [{ action: "movies" }, { action: "shows" }] }
        { id: "search", placement: "auto", title: "Search", text: "Press OK to find any movie or show by its title.", tiles: [{ action: "search" }] }
        { id: "resume", placement: "auto", title: "Continue watching", text: "Pick up right where you stopped, on any screen.", tiles: [{ row: "Continue Watching" }] }
        { id: "livetv", placement: "auto", title: "Live TV", text: "Channels are organized into categories, with a program guide.", tiles: [{ action: "livetv" }] }
        { id: "favorites", placement: "auto", title: "Favorites", text: "Hold OK on any item to save it here.", tiles: [{ action: "favorites" }] }
        { id: "settings", placement: "auto", title: "Settings", text: "See your plan, how many devices you can use and when it expires. You can request an extension right here. The status light shows whether Aurora is online, so you know if a problem is on your end or mine.", tiles: [{ action: "settings" }] }
        { id: "replay", placement: "auto", title: "See this again", text: "Choose Replay tour any time to walk through Aurora again.", tiles: [{ action: "tour" }] }
    ]
end function
