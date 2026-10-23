# Gói lệnh HMI -> robot trên topic /cmd_in (backend phát qua rosbridge).

string MODE_SLAM="SLAM"
string MODE_MANUAL="MANUAL"
string MODE_AUTO="AUTO"
string MODE_STOP="STOP"

# Các đích theo thứ tự đi. Các mode khác AUTO gửi mảng rỗng.
geometry_msgs/PoseStamped[] target

# Một trong MODE_SLAM, MODE_MANUAL, MODE_AUTO, MODE_STOP.
string mode

# Vận tốc joystick. Mode AUTO và STOP luôn là 0.
Joystick joystick

# Pose ước lượng trong frame map. Header stamp = 0 khi người dùng chưa chọn.
geometry_msgs/PoseStamped original_poss
