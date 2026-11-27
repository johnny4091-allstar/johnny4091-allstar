sub init()
  m.poster = m.top.findNode("poster")
  m.title = m.top.findNode("title")
  m.bar = m.top.findNode("bar")
  m.fill = m.top.findNode("barFill")
end sub

sub contentChanged()
  c = m.top.itemContent
  if c = invalid then return
  m.poster.uri = c.HDPosterUrl
  m.title.text = c.title
  pct = 0
  if c.Length > 0 and c.PlayStart > 0 then pct = c.PlayStart / c.Length
  if pct > 0
    m.bar.visible = true
    m.fill.visible = true
    m.fill.width = 240 * pct
  else
    m.bar.visible = false
    m.fill.visible = false
  end if
end sub
