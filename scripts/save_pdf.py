#!/usr/bin/env python3
"""
PDF保存脚本 - 使用pyautogui模拟Ctrl+S保存PDF
"""
import sys
import time

try:
    import pyautogui
except ImportError:
    print("ERROR: pyautogui not installed. Run: pip install pyautogui")
    sys.exit(1)

def save_pdf(delay=1.0):
    """
    模拟Ctrl+S保存PDF
    delay: 按键前等待时间（秒）
    """
    print(f"[save_pdf.py] 等待 {delay} 秒...")
    time.sleep(delay)

    print("[save_pdf.py] 按下 Ctrl+S...")
    pyautogui.hotkey('ctrl', 's')

    # 等待保存对话框出现
    time.sleep(1.0)

    # 按Enter确认保存
    print("[save_pdf.py] 按下 Enter 确认保存...")
    pyautogui.press('enter')

    print("[save_pdf.py] 完成")
    return True

if __name__ == "__main__":
    delay = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
    save_pdf(delay)
