# Gói lệnh HMI -> robot trên topic /cmd_in (backend phát qua rosbridge).

string MODE_SLAM="slam"
string MODE_MANUAL="manual"
string MODE_AUTO="auto"
string MODE_STOP="stop"

# Các đích theo thứ tự đi. Chỉ mode auto có phần tử; slam, manual, stop là mảng rỗng.
geometry_msgs/PoseStamped[] target

# Một trong MODE_SLAM, MODE_MANUAL, MODE_AUTO, MODE_STOP.
string mode

# Vận tốc joystick. Mode auto và stop luôn là 0.
Joystick joystick

# false khi người dùng chưa nhập vị trí ban đầu; khi đó original_position là 0 và phải bỏ qua.
bool has_original_position
OriginalPosition original_position
