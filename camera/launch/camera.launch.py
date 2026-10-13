import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch_ros.actions import Node

def generate_launch_description():
    pkg_share = get_package_share_directory('camera')
    config_file = os.path.join(pkg_share, 'config', 'camera_params.yaml')

    camera_node = Node(
        package='camera',
        executable='intel_camera_node',
        name='intel_camera_node',
        output='screen',
        parameters=[config_file]
    )

    return LaunchDescription([
        camera_node
    ])
