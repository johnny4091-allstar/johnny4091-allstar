sub init()
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.title.text = c.title
    m.poster.uri = c.HDPosterUrl
end sub

' While the guided tour has the list focus on this tile, the tile says where it is on screen, so the tour can light
' it up wherever the list has put it (Tour.brs listens for this).
sub onFocusChange()
    if m.global.tourWatching <> true then return
    if not (m.top.itemHasFocus and m.top.rowListHasFocus) then return
    c = m.top.itemContent
    if c = invalid then return
    r = m.top.sceneBoundingRect()
    m.global.tileRect = { key: tileText(c.action) + "|" + tileText(c.embyId) + "|" + Str(m.top.rowIndex).Trim(), x: r.x, y: r.y, w: r.width, h: r.height, t: Uptime(0) }
end sub

function tileText(v as dynamic) as string
    if v = invalid then return ""
    if type(v) = "roString" or type(v) = "String" then return v
    return Str(v).Trim()
end function
