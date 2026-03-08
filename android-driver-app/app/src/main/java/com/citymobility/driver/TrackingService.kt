package com.citymobility.driver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.location.Location
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.google.android.gms.location.*
import java.util.concurrent.Executors
import kotlin.math.max

class TrackingService : Service() {
    private lateinit var fusedClient: FusedLocationProviderClient
    private val worker = Executors.newSingleThreadExecutor()
    private var callback: LocationCallback? = null

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_STOP) {
            stopTracking(sendStop = true)
            return START_NOT_STICKY
        }

        val baseUrl = intent?.getStringExtra(EXTRA_BASE_URL).orEmpty()
        val token = intent?.getStringExtra(EXTRA_TOKEN).orEmpty()
        val busId = intent?.getStringExtra(EXTRA_BUS_ID).orEmpty()
        val source = intent?.getStringExtra(EXTRA_SOURCE).orEmpty()
        val destination = intent?.getStringExtra(EXTRA_DESTINATION).orEmpty()
        if (baseUrl.isBlank() || token.isBlank() || busId.isBlank() || source.isBlank() || destination.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification("Tracking live location..."))
        startTracking(baseUrl, token, busId, source, destination)
        return START_STICKY
    }

    private fun startTracking(baseUrl: String, token: String, busId: String, source: String, destination: String) {
        if (callback != null) return

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000L)
            .setMinUpdateIntervalMillis(1500L)
            .setMaxUpdateDelayMillis(2500L)
            .build()

        callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                updateNotification(loc)
                upload(baseUrl, token, busId, source, destination, loc)
            }
        }
        fusedClient.requestLocationUpdates(request, callback!!, mainLooper)
    }

    private fun upload(
        baseUrl: String,
        token: String,
        busId: String,
        source: String,
        destination: String,
        loc: Location
    ) {
        worker.execute {
            val speedKmph = max(0.0, loc.speed.toDouble() * 3.6)
            val heading = if (loc.hasBearing()) loc.bearing.toDouble() else 0.0
            ApiClient.uploadLocation(
                baseUrl = baseUrl,
                token = token,
                busId = busId,
                source = source,
                destination = destination,
                lat = loc.latitude,
                lng = loc.longitude,
                speedKmph = speedKmph,
                headingDeg = heading
            )
        }
    }

    private fun stopTracking(sendStop: Boolean) {
        val cb = callback
        if (cb != null) {
            fusedClient.removeLocationUpdates(cb)
            callback = null
        }

        if (sendStop) {
            val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val baseUrl = prefs.getString(KEY_BASE_URL, "").orEmpty()
            val token = prefs.getString(KEY_TOKEN, "").orEmpty()
            val busId = prefs.getString(KEY_BUS_ID, "").orEmpty()
            if (baseUrl.isNotBlank() && token.isNotBlank() && busId.isNotBlank()) {
                worker.execute { ApiClient.stopTracking(baseUrl, token, busId) }
            }
        }

        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun updateNotification(loc: Location) {
        val text = "Last: %.5f, %.5f".format(loc.latitude, loc.longitude)
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(content: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java)
        val openPendingIntent = PendingIntent.getActivity(
            this,
            100,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, TrackingService::class.java).apply { action = ACTION_STOP }
        val stopPendingIntent = PendingIntent.getService(
            this,
            101,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Driver GPS Live Tracking")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(openPendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Driver GPS Tracking",
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Foreground GPS tracking updates"
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        worker.shutdown()
    }

    companion object {
        const val ACTION_START = "com.citymobility.driver.START"
        const val ACTION_STOP = "com.citymobility.driver.STOP"
        const val EXTRA_BASE_URL = "extra_base_url"
        const val EXTRA_TOKEN = "extra_token"
        const val EXTRA_BUS_ID = "extra_bus_id"
        const val EXTRA_SOURCE = "extra_source"
        const val EXTRA_DESTINATION = "extra_destination"

        const val PREFS = "driver_prefs"
        const val KEY_BASE_URL = "base_url"
        const val KEY_TOKEN = "token"
        const val KEY_BUS_ID = "bus_id"
        const val CHANNEL_ID = "driver_tracking_channel"
        const val NOTIFICATION_ID = 5001
    }
}

