package com.citymobility.driver

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.citymobility.driver.TrackingService.Companion.EXTRA_BASE_URL
import com.citymobility.driver.TrackingService.Companion.EXTRA_BUS_ID
import com.citymobility.driver.TrackingService.Companion.EXTRA_DESTINATION
import com.citymobility.driver.TrackingService.Companion.EXTRA_SOURCE
import com.citymobility.driver.TrackingService.Companion.EXTRA_TOKEN
import com.citymobility.driver.TrackingService.Companion.KEY_BASE_URL
import com.citymobility.driver.TrackingService.Companion.KEY_BUS_ID
import com.citymobility.driver.TrackingService.Companion.KEY_TOKEN
import com.citymobility.driver.TrackingService.Companion.PREFS
import com.citymobility.driver.databinding.ActivityMainBinding
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val worker = Executors.newSingleThreadExecutor()
    private var driverToken: String? = null

    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ ->
            updateStatus("Permissions updated. Try Start Live Tracking.")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        restoreSavedFields()

        binding.unlockBtn.setOnClickListener { loginDriver() }
        binding.startBtn.setOnClickListener { startLiveTracking() }
        binding.stopBtn.setOnClickListener { stopLiveTracking() }
        binding.permissionsBtn.setOnClickListener { requestPermissions() }
    }

    private fun restoreSavedFields() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        binding.baseUrlEt.setText(
            prefs.getString(KEY_BASE_URL, "https://live-bus-tracker-mska.onrender.com").orEmpty()
        )
        binding.busIdEt.setText(prefs.getString(KEY_BUS_ID, "").orEmpty())
        driverToken = prefs.getString(KEY_TOKEN, null)
        if (!driverToken.isNullOrBlank()) {
            updateStatus("Driver session restored. You can start tracking.")
        } else {
            updateStatus("Enter details, unlock driver, and start live tracking.")
        }
    }

    private fun loginDriver() {
        val baseUrl = binding.baseUrlEt.text.toString().trim()
        val pin = binding.pinEt.text.toString().trim()
        if (baseUrl.isBlank() || pin.isBlank()) {
            updateStatus("Base URL and PIN are required.")
            return
        }

        updateStatus("Verifying PIN...")
        worker.execute {
            val result = ApiClient.login(baseUrl, pin)
            runOnUiThread {
                if (!result.ok || result.token.isNullOrBlank()) {
                    updateStatus(result.error ?: "Invalid PIN.")
                    return@runOnUiThread
                }
                driverToken = result.token
                saveBasics(baseUrl, binding.busIdEt.text.toString().trim(), result.token)
                updateStatus("Driver unlocked. Start live tracking.")
            }
        }
    }

    private fun startLiveTracking() {
        val baseUrl = binding.baseUrlEt.text.toString().trim()
        val busId = binding.busIdEt.text.toString().trim()
        val source = binding.sourceEt.text.toString().trim()
        val destination = binding.destinationEt.text.toString().trim()
        val token = driverToken

        if (baseUrl.isBlank() || busId.isBlank() || source.isBlank() || destination.isBlank()) {
            updateStatus("Base URL, Bus ID, Source, Destination are required.")
            return
        }
        if (token.isNullOrBlank()) {
            updateStatus("Unlock driver first.")
            return
        }
        if (!hasLocationPermissions()) {
            updateStatus("Location permission missing. Grant permissions first.")
            return
        }

        saveBasics(baseUrl, busId, token)
        val intent = Intent(this, TrackingService::class.java).apply {
            action = TrackingService.ACTION_START
            putExtra(EXTRA_BASE_URL, baseUrl)
            putExtra(EXTRA_TOKEN, token)
            putExtra(EXTRA_BUS_ID, busId)
            putExtra(EXTRA_SOURCE, source)
            putExtra(EXTRA_DESTINATION, destination)
        }
        ContextCompat.startForegroundService(this, intent)
        updateStatus("Foreground tracking started. Works even when screen is off.")
    }

    private fun stopLiveTracking() {
        val intent = Intent(this, TrackingService::class.java).apply {
            action = TrackingService.ACTION_STOP
        }
        ContextCompat.startForegroundService(this, intent)
        updateStatus("Stopping tracking...")
    }

    private fun saveBasics(baseUrl: String, busId: String, token: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_BASE_URL, baseUrl)
            .putString(KEY_BUS_ID, busId)
            .putString(KEY_TOKEN, token)
            .apply()
    }

    private fun hasLocationPermissions(): Boolean {
        val fineGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarseGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return fineGranted && coarseGranted
    }

    private fun requestPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            permissions += Manifest.permission.ACCESS_BACKGROUND_LOCATION
        }
        locationPermissionLauncher.launch(permissions.toTypedArray())
    }

    private fun updateStatus(message: String) {
        binding.statusTv.text = message
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        super.onDestroy()
        worker.shutdown()
    }
}

