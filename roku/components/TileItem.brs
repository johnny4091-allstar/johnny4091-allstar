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
