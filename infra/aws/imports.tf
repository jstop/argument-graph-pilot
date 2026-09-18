# One-time adoption of what demo2 made by hand. Harmless once applied; kept as the record of what was adopted.
import {
  to = aws_instance.pilot
  id = "i-0d62b7360fa227675"
}
import {
  to = aws_security_group.pilot
  id = "sg-0a20ec2a59aeaa756"
}
import {
  to = aws_eip.pilot
  id = "eipalloc-07ca8eb70ff8b51ba"
}
import {
  to = aws_eip_association.pilot
  id = "eipassoc-0931410ee847759bc"
}
import {
  for_each = toset(local.hosts)
  to       = aws_route53_record.host[each.key]
  id       = "${data.aws_route53_zone.main.zone_id}_${each.key}.${var.domain}_A"
}
