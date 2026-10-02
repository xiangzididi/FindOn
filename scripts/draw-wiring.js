import { writeFileSync } from 'node:fs';
const c={ink:'#203448',muted:'#586a7a',line:'#344e65',blue:'#1768ac',red:'#b43b35',green:'#168077',bg:'#f5f7fa'};
let s=[];
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;');
const text=(x,y,t,size=19,color=c.ink,weight=400)=>s.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}">${esc(t)}</text>`);
const path=(d,color=c.line,width=2)=>s.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>`);
const box=(x,y,w,h,title)=>{s.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="white" stroke="#bccad5"/>`);if(title)text(x+20,y+33,title,22,c.ink,600);};
const dot=(x,y)=>s.push(`<circle cx="${x}" cy="${y}" r="4" fill="${c.line}"/>`);
const wire=(x1,y1,x2,y2,label='',color=c.blue)=>{path(`M${x1} ${y1}H${x2}V${y2}`,color);if(label)text((x1+x2)/2-35,y1-9,label,16,color);};
const ground=(x,y)=>{path(`M${x} ${y}v12m-14 0h28m-23 6h18m-13 6h8`);};
const resistor=(x,y)=>{path(`M${x} ${y}v10`);s.push(`<rect x="${x-5}" y="${y+10}" width="10" height="24" fill="white" stroke="${c.line}" stroke-width="2"/>`);path(`M${x} ${y+34}v10`);};
s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1700" height="1330" viewBox="0 0 1700 1330"><title>格物双轴零件柜接线图 R2</title><desc>ESP32-S3-N16R8 使用脉冲方向控制 PD42S1 与 A4988，当前没有原点或限位开关，共地供电。候选接线，尚未实物验证。</desc><rect width="1700" height="1330" fill="${c.bg}"/><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">`);
text(45,53,'格物 / 单层两格 · 双轴电气接线图',32,c.ink,600);
text(45,88,'R2 · 2026-10-02    GPIO 为候选分配；按端子名称接线，图中排列不代表模块实物针脚顺序。',19,c.muted);
text(45,118,'同名网络（+3V3 / GND / +VM）相连；实心圆为连接点，交叉无圆点不相连。两轴均为 STEP/DIR。',18,c.muted);

box(40,145,790,340,'01  X 轴：PD42S1 + 丝杆 / 导轨');
box(65,205,210,210,'ESP32-S3'); box(560,205,240,210,'PD42S1');
for(const [i,l,r] of [[0,'GPIO17','STP'],[1,'GPIO18','DIR'],[2,'3V3','COM'],[3,'GND','GND']]) {
 const y=265+i*39;text(85,y+6,l);text(580,y+6,r);wire(275,y,560,y,'',i===2?c.red:i===3?c.line:c.blue);
}
text(65,447,'LCD：脉冲模式；EN 保持有效、EN 端不接（沿用用户示例）。',18);
text(65,473,'16 细分；电机 → 1:50 减速箱 → 2 mm 导程丝杆。电机供电见 04。',17,c.muted);

box(860,145,800,580,'02  E 轴：A4988 + 约 50 mm 丝杆模组');
box(885,235,200,200,'ESP32-S3');box(1290,225,225,450,'A4988');
for(const [y,l,r] of [[295,'GPIO15','STEP'],[340,'GPIO16','DIR'],[400,'GPIO7','EN（低有效）']]) {text(905,y+6,l);text(1310,y+6,r,18);wire(1085,y,1290,y);}
text(1150,222,'+3V3',17,c.red);path('M1180 232V240',c.red);resistor(1180,240);path('M1180 284V400');dot(1180,400);text(1192,272,'10 kΩ',16);
text(886,480,'STEP、DIR 各接 10 kΩ 下拉到 GND。',17,c.muted);
text(886,508,'EN 上拉：控制器启动时默认禁用。',17,c.muted);
text(886,550,'+3V3',18,c.red);wire(960,544,1290,544,'VDD',c.red);text(1310,550,'VDD');
path('M1220 544V600H1290',c.red);dot(1220,544);text(1310,588,'RST');text(1310,615,'SLP');path('M1270 582H1290M1270 582V609H1290',c.red);dot(1270,600);
text(886,584,'RST、SLP 短接后接 +3V3。',17,c.muted);
text(886,620,'MS1 / MS2 / MS3 → +3V3',17,c.red);
text(886,650,'建议 1/16 细分；固件参数须一致。',17,c.muted);
text(1310,652,'MS1 / MS2 / MS3',16);
text(1185,682,'+3V3',16,c.red);path('M1220 669V646H1290',c.red);
for(const [y,p,n] of [[280,'1A','A'],[318,'1B','A'],[360,'2A','B'],[398,'2B','B']]) {text(1445,y+6,p,16);path(`M1515 ${y}H1580`,c.green);text(1610,y+6,n,17,c.green);}
path('M1580 280c20 0 20 12.6 0 12.6c20 0 20 12.7 0 12.7c20 0 20 12.7 0 12.7M1580 360c20 0 20 12.6 0 12.6c20 0 20 12.7 0 12.7c20 0 20 12.7 0 12.7',c.green);
text(1530,455,'电机线圈',16,c.green);text(1530,480,'A 对 / B 对',16,c.green);
text(886,700,'线圈按万用表测得的两组线对连接，不按线色猜；VMOT / GND 见 04。',17,c.muted);

box(40,505,790,220,'03  当前无原点 / 限位开关');
text(70,568,'GPIO4、GPIO5 保持不连接，不在固件中配置为回零输入。',19);
text(70,610,'断开电机电源后，人工对准：X 左侧取物区标记；E 完全回缩安全标记。',18,c.blue);
text(70,650,'控制器复位、掉电、堵转、丢步或人工移动后，人工参考立即失效。',18,c.red);
text(70,690,'没有硬件端点保护：仅允许短距离低速点动，软限位尚未标定。',18,c.red);

box(40,745,1620,310,'04  供电与共地');
box(65,815,195,140,'直流电源');text(85,885,'12 V 候选',21,c.red);text(85,919,'电流容量待核算',17,c.muted);
text(285,843,'F1 保险丝');path('M260 865H330');s.push('<rect x="330" y="855" width="50" height="20" fill="white" stroke="#344e65" stroke-width="2"/>');path('M380 865H465');
text(430,812,'S0 电机电源切断');text(430,838,'需匹配直流负载额定值',16,c.muted);path('M465 865L520 850M520 865H620');
text(610,843,'+VM',18,c.red);path('M620 865H740V805H920M740 865V915H920',c.red,3);dot(740,865);
text(935,811,'PD42S1 电源正端（核对实际丝印）',20,c.red);text(935,921,'A4988 VMOT',20,c.red);
path('M260 955H1410',c.line,3);text(285,982,'电源负极 / GND 星形接地点',18);text(850,1016,'PD42S1 GND、A4988 两个 GND、ESP32 GND 全部共地。',19);
path('M1180 915V928M1165 928H1195M1165 936H1195M1180 936V955');dot(1180,915);dot(1180,955);path('M1140 915H1180',c.red);text(1205,912,'+',18,c.red);text(1210,936,'C1 ≥47 µF（建议100 µF / 35 V，12 V供电时）',15);
text(1125,897,'+VM',17,c.red);
text(1210,978,'电解电容靠近 VMOT，正端接 +VM。',16,c.muted);
text(65,1020,'PC USB → ESP32-S3 USB 供电 / 通信；ESP32 的 3V3 仅供逻辑。',18);

text(45,1100,'装配前核对',23,c.ink,600);
text(45,1136,'① 电源暂按 12 V 规划；核对驱动板额定值与负载，先设置 A4988 限流，禁止带电插拔电机。',19);
text(45,1170,'② A4988：Vref = 8 × Imax × Rs；Rs 按实际板上采样电阻，Imax 不超过电机与载板允许值。',19);
text(45,1204,'③ PD42S1 EN 未接时不能靠软件撤销使能；S0 只示意电机断电路径，不代表完整安全急停系统。',19);
text(45,1238,'④ 当前无原点/限位开关；GPIO4/5 不连接。先做人工基准标记，再标定软限位与两格坐标。',19);
text(45,1284,'依据：用户提供的 PD42S1 脉冲示例 / 正点原子 PD42S1 手册 / Pololu A4988 载板说明。未完成实物接线验证。',17,c.muted);
s.push('</g></svg>');writeFileSync(new URL('../docs/cabinet-wiring.svg',import.meta.url),s.join('\n'));
